import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { API, PROVIDER, streamClaudeAgentSdk } from "./provider.ts";
import { discoverSdkModels } from "./models.ts";

export default function claudeAgentSdk(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    // Registry metadata only: inference uses SDK subprocesses, not this URL.
    baseUrl: "https://claude-agent-sdk.invalid",
    apiKey: "unused-by-claude-agent-sdk",
    api: API,
    streamSimple: streamClaudeAgentSdk,
    fetchDynamicModels: () => discoverSdkModels(),
  });
}
