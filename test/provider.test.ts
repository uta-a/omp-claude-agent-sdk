import { describe, expect, spyOn, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { API, PROVIDER, promptCacheTtl, promptCachingDisabled, sdkEnvironment, streamClaudeAgentSdk } from "../src/provider.ts";
import { conversationPrompt } from "../src/conversation.ts";

const model = { id: "haiku", api: API, provider: PROVIDER } as Model;
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const tools: Context["tools"] = [{ name: "lookup", description: "Look up a key", parameters: { type: "object", properties: { key: { type: "string" } } } }];

function fixture(messages: unknown[]) {
  let closed = false;
  return {
    run: () => ({
      async *[Symbol.asyncIterator]() { for (const message of messages) yield message as SDKMessage; },
      close() { closed = true; },
    }),
    get closed() { return closed; },
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "", total_cost_usd: 0.01,
    modelUsage: { haiku: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } }, ...overrides };
}

function partial(event: Record<string, unknown>) { return { type: "stream_event", parent_tool_use_id: null, event }; }
function assistant(content: unknown[]) { return { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model: "claude-haiku", content } }; }

async function collect(messages: unknown[], input: Context = context) {
  const source = fixture(messages);
  const stream = streamClaudeAgentSdk(model, input, {}, source.run);
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, output: await stream.result(), source };
}

describe("SDK stream boundaries", () => {
  test("complete assistant snapshots do not duplicate streamed text", async () => {
    const { events, output, source } = await collect([
      partial({ type: "message_start", message: { id: "msg_1", model: "claude-haiku" } }),
      partial({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      assistant([{ type: "text", text: "Hello" }]),
      partial({ type: "content_block_stop", index: 0 }), result(),
    ]);
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join("")).toBe("Hello");
    expect(events.filter(event => event.type === "text_end")).toHaveLength(1);
    expect(output.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(output.usage).toMatchObject({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.01 } });
    expect(source.closed).toBe(true);
  });

  test("deferred parallel calls become executable OMP calls with original IDs", async () => {
    const { output, events } = await collect([
      assistant([
        { type: "tool_use", id: "one", name: "mcp__omp__lookup", input: { key: "a" } },
        { type: "tool_use", id: "two", name: "mcp__omp__lookup", input: { key: "b" } },
      ]), result({ stop_reason: "tool_deferred" }),
    ], { ...context, tools });
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      { type: "toolCall", id: "one", name: "lookup", arguments: { key: "a" } },
      { type: "toolCall", id: "two", name: "lookup", arguments: { key: "b" } },
    ]);
    expect(events.filter(event => event.type === "toolcall_end").map(event => event.toolCall.id)).toEqual(["one", "two"]);
  });

  test("bare read and bash calls retain their names, arguments and IDs when deferred", async () => {
    const { output, events } = await collect([
      assistant([
        { type: "tool_use", id: "read-id", name: "read", input: { path: "README.md" } },
        { type: "tool_use", id: "bash-id", name: "bash", input: { command: "pwd" } },
      ]), result({ stop_reason: "tool_deferred" }),
    ], { ...context, tools: [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
    ] });
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      { type: "toolCall", id: "read-id", name: "read", arguments: { path: "README.md" } },
      { type: "toolCall", id: "bash-id", name: "bash", arguments: { command: "pwd" } },
    ]);
    expect(events.filter(event => event.type === "toolcall_end").map(event => event.toolCall.name)).toEqual(["read", "bash"]);
  });

  test("an SDK failure cannot release pending tool calls", async () => {
    const { output, events } = await collect([
      assistant([{ type: "tool_use", id: "one", name: "mcp__omp__lookup", input: { key: "a" } }]),
      result({ subtype: "error_during_execution", is_error: true, errors: ["authentication failed"] }),
    ], { ...context, tools });
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toContain("authentication failed");
    expect(events.some(event => event.type === "toolcall_end")).toBe(false);
  });

  test("undeferred calls and unknown tools fail closed", async () => {
    for (const [name, stopReason, error] of [
      ["mcp__omp__lookup", "end_turn", "did not defer"],
      ["lookup", "end_turn", "did not defer"],
      ["read", "tool_deferred", "unknown OMP tool"],
      ["bash", "tool_deferred", "unknown OMP tool"],
      ["mcp__other__lookup", "tool_deferred", "unknown OMP tool"],
      ["Bash", "tool_deferred", "unknown OMP tool"],
    ]) {
      const { output } = await collect([
        assistant([{ type: "tool_use", id: "one", name, input: {} }]), result({ stop_reason: stopReason }),
      ], { ...context, tools });
      expect(output.stopReason).toBe("error");
      expect(output.errorMessage).toContain(error);
      expect(output.content.some(block => block.type === "toolCall")).toBe(false);
    }
  });

  test("a missing terminal result is an error, not a successful partial reply", async () => {
    const { output } = await collect([assistant([{ type: "text", text: "Partial" }])]);
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toContain("without a result");
  });

  test("completed and failed requests retain elapsed time for OMP throughput", async () => {
    let now = 1000;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      for (const failed of [false, true]) {
        now = 1000;
        const stream = streamClaudeAgentSdk(model, context, {}, () => ({
          async *[Symbol.asyncIterator]() {
            now = 1250;
            yield assistant([{ type: "text", text: "Hello" }]) as SDKMessage;
            now = 2000;
            yield result(failed
              ? { subtype: "error_during_execution", is_error: true, errors: ["request failed"] }
              : {}) as unknown as SDKMessage;
          },
          close() {},
        }));
        const output = await stream.result();
        expect(output.stopReason).toBe(failed ? "error" : "stop");
        expect(output.duration).toBe(1000);
      }
    } finally {
      clock.mockRestore();
    }
  });

  test("pre-aborted requests never start a subprocess", async () => {
    let started = false;
    const output = await streamClaudeAgentSdk(model, context, { signal: AbortSignal.abort() }, () => {
      started = true;
      throw new Error("Unexpected subprocess");
    }).result();
    expect(started).toBe(false);
    expect(output.stopReason).toBe("aborted");
  });

  test("cancellation propagates to the SDK and closes its handle", async () => {
    const controller = new AbortController();
    let closed = false;
    let propagated = false;
    const stream = streamClaudeAgentSdk(model, context, { signal: controller.signal }, params => ({
      async *[Symbol.asyncIterator]() {
        controller.abort();
        propagated = params.options!.abortController!.signal.aborted;
        yield result() as unknown as SDKMessage;
      },
      close() { closed = true; },
    }));
    for await (const _event of stream) { /* Drain through cleanup. */ }
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(propagated).toBe(true);
    expect(closed).toBe(true);
  });
});

test("history preserves tool failures and IDs without leaking signed thinking", () => {
  const content = conversationPrompt({ messages: [
    { api: API, provider: PROVIDER, model: model.id, role: "assistant", content: [{ type: "thinking", thinking: "private", thinkingSignature: "signature" }, { type: "toolCall", id: "call", name: "lookup", arguments: { key: "x" } }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "call", toolName: "lookup", content: [{ type: "text", text: "not found" }], isError: true, timestamp: 2 },
  ] });
  expect(Array.isArray(content)).toBe(true);
  const transcript = (content as Array<{ text: string }>).map(block => JSON.parse(block.text));
  expect(transcript[0].content).toEqual([{ type: "toolCall", id: "call", name: "lookup", arguments: { key: "x" } }]);
  expect(transcript[1]).toMatchObject({ toolCallId: "call", isError: true });
  expect(JSON.stringify(transcript)).not.toContain("private");
});

test("a deferred result with a lost tool call cannot silently succeed", async () => {
  const { output } = await collect([result({ stop_reason: "tool_deferred" })]);
  expect(output.stopReason).toBe("error");
  expect(output.errorMessage).toContain("without returning its call");
});

test("image attachments preserve bytes and transcript positions", () => {
  const content = conversationPrompt({ messages: [{
    role: "user", timestamp: 1, content: [
      { type: "text", text: "Describe this" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ],
  }] });
  const blocks = content as Array<{ type: string; text?: string; source?: unknown }>;
  expect(JSON.parse(blocks[0].text!).content[1]).toEqual({ type: "text", text: "[Attached image 1]" });
  expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } });
  expect(() => conversationPrompt({ messages: [{
    role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }],
  }] })).toThrow("does not support image type");
});

describe("prompt cache prefix", () => {
  const png = (data: string) => ({ type: "image" as const, mimeType: "image/png", data });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const history: Context["messages"] = [
    { role: "user", timestamp: 1, content: [{ type: "text", text: "Look at this \"quoted\"\nfile" }, png("Zmlyc3Q=")] },
    { api: API, provider: PROVIDER, model: model.id, role: "assistant", usage, stopReason: "toolUse", timestamp: 2,
      content: [{ type: "text", text: "Checking" }, { type: "toolCall", id: "call-1", name: "lookup", arguments: { key: "a", nested: { z: 1, y: [2] } } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "lookup", isError: false, timestamp: 3, content: [{ type: "text", text: "found" }, png("c2Vjb25k")] },
    { api: API, provider: PROVIDER, model: model.id, role: "assistant", usage, stopReason: "toolUse", timestamp: 4,
      content: [{ type: "toolCall", id: "call-2", name: "lookup", arguments: { key: "b" } }, { type: "toolCall", id: "call-3", name: "lookup", arguments: { key: "c" } }] },
    { role: "toolResult", toolCallId: "call-2", toolName: "lookup", isError: false, timestamp: 5, content: [{ type: "text", text: "two" }] },
    { role: "toolResult", toolCallId: "call-3", toolName: "lookup", isError: true, timestamp: 6, content: [{ type: "text", text: "three" }] },
    { role: "user", timestamp: 7, content: "Thanks" },
  ];
  const render = (count: number) => conversationPrompt({ messages: history.slice(0, count) }) as unknown[];

  test("each turn's blocks are a byte-identical prefix of the next turn's blocks", () => {
    for (let count = 1; count < history.length; count++) {
      const current = render(count);
      for (const added of [1, 2]) {
        if (count + added > history.length) continue;
        const next = render(count + added);
        expect(next.length).toBeGreaterThan(current.length);
        expect(JSON.stringify(next.slice(0, current.length))).toBe(JSON.stringify(current));
      }
    }
  });

  test("each history entry is its own block and images stay next to their entry", () => {
    const blocks = render(history.length) as Array<{ type: string; text?: string; source?: { data: string } }>;
    expect(blocks.map(block => block.type)).toEqual(["text", "image", "text", "text", "image", "text", "text", "text", "text"]);
    expect(JSON.parse(blocks[0].text!)).toEqual({ role: "user", content: [{ type: "text", text: "Look at this \"quoted\"\nfile" }, { type: "text", text: "[Attached image 1]" }] });
    expect(blocks[1].source!.data).toBe("Zmlyc3Q=");
    expect(JSON.parse(blocks[3].text!).content[1]).toEqual({ type: "text", text: "[Attached image 2]" });
    expect(blocks[4].source!.data).toBe("c2Vjb25k");
    expect(JSON.parse(blocks[8].text!)).toEqual({ role: "user", content: "Thanks" });
    expect(blocks.some(block => block.text?.includes("conversation"))).toBe(false);
  });

  test("only the last block of the sent prompt carries a cache breakpoint", async () => {
    let sent: Array<Record<string, unknown>> = [];
    let sentTtl: string | undefined;
    const output = await streamClaudeAgentSdk(model, { messages: history }, {}, params => ({
      async *[Symbol.asyncIterator]() {
        sentTtl = params.options!.env!.CLAUDE_CODE_PROMPT_CACHE_TTL;
        for await (const message of params.prompt as AsyncIterable<{ message: { content: Array<Record<string, unknown>> } }>) sent = message.message.content;
        yield result() as unknown as SDKMessage;
      },
      close() {},
    })).result();
    expect(output.stopReason).toBe("stop");
    expect(sent).toHaveLength(9);
    expect(["5m", "1h"]).toContain(sentTtl!);
    expect(sent.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: sentTtl });
    expect(sent.slice(0, -1).some(block => "cache_control" in block)).toBe(false);
    expect(JSON.stringify(sent.map(({ cache_control: _, ...block }) => block))).toBe(JSON.stringify(conversationPrompt({ messages: history })));
  });
});

test("the pinned prompt cache TTL follows the auth mode unless set explicitly", () => {
  expect(promptCacheTtl({})).toBe("1h");
  expect(promptCacheTtl({ OMP_CLAUDE_AUTH: "environment" })).toBe("5m");
  expect(promptCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })).toBe("5m");
  expect(promptCacheTtl({ OMP_CLAUDE_AUTH: "environment", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" })).toBe("1h");
  expect(promptCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "10m" })).toBe("1h");
  expect(["5m", "1h"]).toContain(sdkEnvironment({}).CLAUDE_CODE_PROMPT_CACHE_TTL!);
});

test("disabled prompt caching sends no transcript breakpoint", async () => {
  expect(promptCachingDisabled({}, "claude-opus-5-5")).toBe(false);
  expect(promptCachingDisabled({ DISABLE_PROMPT_CACHING: "1" }, "claude-opus-5-5")).toBe(true);
  expect(promptCachingDisabled({ DISABLE_PROMPT_CACHING: "true" }, "haiku")).toBe(true);
  expect(promptCachingDisabled({ DISABLE_PROMPT_CACHING: "0" }, "haiku")).toBe(false);
  expect(promptCachingDisabled({ DISABLE_PROMPT_CACHING_OPUS: "1" }, "claude-opus-5-5")).toBe(true);
  expect(promptCachingDisabled({ DISABLE_PROMPT_CACHING_OPUS: "1" }, "claude-haiku-5-5")).toBe(false);
  expect(promptCachingDisabled({ DISABLE_PROMPT_CACHING_HAIKU: "1" }, "haiku")).toBe(true);
  const previous = process.env.DISABLE_PROMPT_CACHING;
  process.env.DISABLE_PROMPT_CACHING = "1";
  let sent: Array<Record<string, unknown>> = [];
  try {
    await streamClaudeAgentSdk(model, context, {}, params => ({
      async *[Symbol.asyncIterator]() {
        for await (const message of params.prompt as AsyncIterable<{ message: { content: Array<Record<string, unknown>> } }>) sent = message.message.content;
        yield result() as unknown as SDKMessage;
      },
      close() {},
    })).result();
  } finally {
    if (previous === undefined) delete process.env.DISABLE_PROMPT_CACHING;
    else process.env.DISABLE_PROMPT_CACHING = previous;
  }
  expect(sent).toHaveLength(1);
  expect(sent.some(block => "cache_control" in block)).toBe(false);
});
