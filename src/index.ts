import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { API, PROVIDER, streamClaudeAgentSdk } from "./provider.ts";

export default function claudeAgentSdk(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    // Registry metadata only: inference uses SDK subprocesses, not this URL.
    baseUrl: "https://claude-agent-sdk.invalid",
    apiKey: "unused-by-claude-agent-sdk",
    api: API,
    streamSimple: streamClaudeAgentSdk,
    models: ["opus", "sonnet", "haiku"].map(id => ({
      id,
      name: `Claude ${id[0].toUpperCase()}${id.slice(1)} (Agent SDK)`,
      reasoning: true,
      input: ["text", "image"],
      // Alias limits are deliberately conservative; SDK entitlement decides
      // the concrete model. SDK-reported usage carries the actual estimate.
      contextWindow: 200_000,
      maxTokens: 32_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
}
