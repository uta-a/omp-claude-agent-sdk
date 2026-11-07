import { query, type McpSdkServerConfigWithInstance, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@oh-my-pi/pi-ai";
import { createToolBridge } from "./bridge.ts";
import { BRIDGE_INSTRUCTIONS, conversationPrompt } from "./conversation.ts";

// OMP displays the provider ID verbatim as the /model category label.
export const PROVIDER = "anthropic-agent-sdk";
export const API = "claude-agent-sdk-stream";

type QueryHandle = AsyncIterable<SDKMessage> & { close(): void };
type QueryRunner = (params: Parameters<typeof query>[0]) => QueryHandle;

export function sdkEnvironment(options: SimpleStreamOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // OMP may have upstream credentials configured for other providers. Do not
  // accidentally replace the user's Claude Code login with API-key billing.
  if (env.OMP_CLAUDE_AUTH !== "environment") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_OAUTH_TOKEN;
    delete env.ANTHROPIC_FOUNDRY_API_KEY;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.CLAUDE_CODE_USE_FOUNDRY;
  }
  delete env.CLAUDECODE;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // Pin Claude Code's cache TTL so the transcript breakpoint can use the same
  // one; the API rejects a 5m breakpoint placed before a 1h breakpoint.
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = promptCacheTtl(env);
  if (options.maxTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxTokens);
  return env;
}

// Mirrors Claude Code's automatic choice: 1h for the subscription login, 5m for
// API credentials. Pinned because its automatic choice can change mid-session.
export function promptCacheTtl(env: NodeJS.ProcessEnv): "5m" | "1h" {
  const ttl = env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  if (ttl === "5m" || ttl === "1h") return ttl;
  return env.OMP_CLAUDE_AUTH === "environment" ? "5m" : "1h";
}

export function streamClaudeAgentSdk(
  model: Model,
  context: Context,
  options: SimpleStreamOptions = {},
  runQuery: QueryRunner = query,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void produce(stream, model, context, options, runQuery);
  return stream;
}

async function produce(
  stream: AssistantMessageEventStream,
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  runQuery: QueryRunner,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant", api: API, provider: PROVIDER, model: model.id,
    content: [], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  let active: QueryHandle | undefined;
  let bridge: McpSdkServerConfigWithInstance | undefined;
  let stderr = "";
  let terminal: Extract<SDKMessage, { type: "result" }> | undefined;
  const pendingTools: ToolCall[] = [];
  const blocks = new Map<number, number>();
  const ended = new Set<number>();
  const closeBlock = (index: number) => {
    if (ended.has(index)) return;
    const block = output.content[index];
    if (block?.type === "text") stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
    if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
    ended.add(index);
  };

  try {
    options.signal?.throwIfAborted();
    if (options.toolChoice && options.toolChoice !== "auto" && options.toolChoice !== "none") {
      throw new Error("Claude Agent SDK supports only auto or none toolChoice");
    }
    const tools = options.toolChoice === "none" ? [] : context.tools ?? [];
    if (tools.length) bridge = createToolBridge(tools);
    const env = sdkEnvironment(options);
    const sdkOptions: Options = {
      model: model.id,
      cwd: options.cwd ?? process.cwd(),
      env,
      abortController: controller,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: bridge ? { omp: bridge } : {},
      toolAliases: Object.fromEntries(tools.map(tool => [tool.name, `mcp__omp__${tool.name}`])),
      includePartialMessages: true,
      persistSession: false,
      maxTurns: 1,
      verbatimPrompts: true,
      systemPrompt: [...context.systemPrompt ?? [], BRIDGE_INSTRUCTIONS],
      thinking: options.disableReasoning ? { type: "disabled" } : undefined,
      effort: options.reasoning === "minimal" ? "low" : options.reasoning,
      pathToClaudeCodeExecutable: process.env.OMP_CLAUDE_EXECUTABLE || undefined,
      stderr: data => { stderr = (stderr + data).slice(-4096); },
      hooks: { PreToolUse: [{ hooks: [async () => ({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
      })] }] },
    };
    const content: SDKUserMessage["message"]["content"] = conversationPrompt(context);
    // Claude Code marks only its trailing environment message, which follows this
    // prompt, so mark the transcript end for the next turn to read it back.
    const last = content.at(-1);
    if (last) Object.assign(last, { cache_control: { type: "ephemeral", ttl: promptCacheTtl(env) } });
    active = runQuery({
      prompt: (async function* () {
        yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null, session_id: "" };
      })(),
      options: sdkOptions,
    });
    stream.push({ type: "start", partial: output });
    for await (const message of active) {
      controller.signal.throwIfAborted();
      if (message.type === "result") {
        terminal = message;
        break;
      }
      if (message.type === "assistant" && !message.parent_tool_use_id) {
        if (message.error) throw new Error(`Claude Agent SDK: ${message.error}: ${JSON.stringify(message.message.content)}`);
        output.responseId = message.message.id;
        output.upstreamModel = message.message.model;
        for (const [index, block] of message.message.content.entries()) {
          if (block.type === "tool_use") {
            // SDK assistant blocks retain model-emitted names even when aliases
            // resolve them to our MCP bridge for deferral.
            const name = block.name.startsWith("mcp__omp__") ? block.name.slice("mcp__omp__".length) : block.name;
            if (!tools.some(tool => tool.name === name)) throw new Error(`SDK requested an unknown OMP tool: ${block.name}`);
            pendingTools.push({ type: "toolCall", id: block.id, name, arguments: block.input as Record<string, unknown> });
          } else if (block.type === "text" || block.type === "thinking") {
            if (block.type === "thinking" && options.hideThinkingSummary) continue;
            let target = blocks.get(index);
            if (target === undefined) {
              target = output.content.length;
              blocks.set(index, target);
              output.content.push(block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
              stream.push({ type: block.type === "text" ? "text_start" : "thinking_start", contentIndex: target, partial: output });
            }
            const existing = output.content[target];
            if (existing.type === "text" && block.type === "text") {
              const delta = block.text.slice(existing.text.length);
              existing.text = block.text;
              if (delta) stream.push({ type: "text_delta", contentIndex: target, delta, partial: output });
            } else if (existing.type === "thinking" && block.type === "thinking") {
              const delta = block.thinking.slice(existing.thinking.length);
              existing.thinking = block.thinking;
              existing.thinkingSignature = block.signature;
              if (delta) stream.push({ type: "thinking_delta", contentIndex: target, delta, partial: output });
            }
          }
        }
      }
      if (message.type !== "stream_event" || message.parent_tool_use_id) continue;
      const event = message.event;
      if (event.type === "message_start") {
        blocks.clear();
        output.responseId = event.message.id;
        output.upstreamModel = event.message.model;
      } else if (event.type === "content_block_start" && (event.content_block.type === "text" || event.content_block.type === "thinking")) {
        if (event.content_block.type === "thinking" && options.hideThinkingSummary) continue;
        const index = output.content.length;
        blocks.set(event.index, index);
        const block = event.content_block;
        output.content.push(block.type === "text" ? { type: "text", text: block.text } : { type: "thinking", thinking: block.thinking });
        stream.push({ type: block.type === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: output });
        const delta = block.type === "text" ? block.text : block.thinking;
        if (delta) stream.push({ type: block.type === "text" ? "text_delta" : "thinking_delta", contentIndex: index, delta, partial: output });
      } else if (event.type === "content_block_delta") {
        const index = blocks.get(event.index);
        if (index === undefined) continue;
        const block = output.content[index];
        if (event.delta.type === "text_delta" && block.type === "text") {
          block.text += event.delta.text;
          stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
        } else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += event.delta.thinking;
          if (!options.hideThinkingSummary) stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
        } else if (event.delta.type === "signature_delta" && block.type === "thinking") {
          block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
        }
      } else if (event.type === "content_block_stop") {
        const index = blocks.get(event.index);
        if (index !== undefined) closeBlock(index);
      }
    }
    controller.signal.throwIfAborted();
    if (!terminal) throw new Error("Claude Agent SDK ended without a result");
    for (const item of Object.values(terminal.modelUsage)) {
      output.usage.input += item.inputTokens;
      output.usage.output += item.outputTokens;
      output.usage.cacheRead += item.cacheReadInputTokens;
      output.usage.cacheWrite += item.cacheCreationInputTokens;
    }
    output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    output.usage.cost.total = terminal.total_cost_usd;
    if (terminal.is_error || terminal.subtype !== "success") {
      throw new Error(`Claude Agent SDK ${terminal.subtype}: ${"errors" in terminal ? terminal.errors.join("; ") : terminal.result}`);
    }
    if (pendingTools.length && terminal.stop_reason !== "tool_deferred") {
      throw new Error("Claude Agent SDK did not defer tool execution to OMP");
    }
    if (!pendingTools.length && terminal.stop_reason === "tool_deferred") {
      throw new Error("Claude Agent SDK deferred a tool without returning its call");
    }
    for (let index = 0; index < output.content.length; index++) closeBlock(index);
    for (const toolCall of pendingTools) {
      const contentIndex = output.content.length;
      output.content.push(toolCall);
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }
    output.stopReason = pendingTools.length ? "toolUse" : terminal.stop_reason === "max_tokens" ? "length" : "stop";
    stream.push({ type: "done", reason: output.stopReason, message: output });
  } catch (error) {
    output.stopReason = controller.signal.aborted || options.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    if (stderr && output.stopReason === "error") output.errorMessage += `\n${stderr.trim()}`;
    stream.push({ type: "error", reason: output.stopReason, error: output });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    active?.close();
    await bridge?.instance.close().catch(() => {});
    stream.end();
  }
}
