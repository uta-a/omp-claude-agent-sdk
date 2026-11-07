import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { API, PROVIDER, streamClaudeAgentSdk } from "../src/provider.ts";
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
  const transcript = JSON.parse((content as Array<{ text: string }>)[0].text);
  expect(transcript.conversation[0].content).toEqual([{ type: "toolCall", id: "call", name: "lookup", arguments: { key: "x" } }]);
  expect(transcript.conversation[1]).toMatchObject({ toolCallId: "call", isError: true });
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
  expect(JSON.parse(blocks[0].text!).conversation[0].content[1]).toEqual({ type: "text", text: "[Attached image 1]" });
  expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } });
  expect(() => conversationPrompt({ messages: [{
    role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }],
  }] })).toThrow("does not support image type");
});
