import { query, type ModelInfo, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { sdkEnvironment } from "./provider.ts";

type ModelQuery = Pick<Query, "supportedModels" | "close">;
type ModelQueryFactory = (params: Parameters<typeof query>[0]) => ModelQuery;

/** Register only SDK-returned rows, not every candidate in the bundled catalog. */
export function sdkModelDefinitions(rows: ModelInfo[], catalog: Model[]): ProviderModelConfig[] {
  const metadata = new Map(catalog.map(model => [model.id, model]));
  const models = new Map<string, ProviderModelConfig>();
  for (const row of rows) {
    const id = row.resolvedModel ?? row.value;
    const known = metadata.get(id);
    models.set(id, {
      id,
      // Catalog names include revision numbers. For a new/custom model, its
      // exact SDK ID is safer than an unversioned family label such as Opus.
      name: known?.name ?? id,
      reasoning: known?.reasoning ?? Boolean(row.supportsEffort || row.supportsAdaptiveThinking),
      thinking: row.supportedEffortLevels?.length
        ? { mode: "effort", efforts: row.supportedEffortLevels as Effort[] }
        : known?.thinking,
      input: known?.input ?? ["text", "image"],
      contextWindow: known?.contextWindow ?? 200_000,
      maxTokens: known?.maxTokens ?? 32_000,
      cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Enumerate without sending a user prompt or making an inference request. */
export async function discoverSdkModels(runQuery: ModelQueryFactory = query): Promise<ProviderModelConfig[]> {
  const catalog = getBundledModels("anthropic");
  const gate = Promise.withResolvers<void>();
  const controller = new AbortController();
  const session = runQuery({
    prompt: (async function* () { await gate.promise; })(),
    options: {
      env: sdkEnvironment({}),
      abortController: controller,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      pathToClaudeCodeExecutable: process.env.OMP_CLAUDE_EXECUTABLE || undefined,
      // supportedModels normally returns only today's recommended families.
      // Asking the SDK to offer explicit versions also covers legacy models,
      // while its availability and managed-policy filters remain authoritative.
      settings: {
        modelPicker: { options: catalog.map(model => ({ model: model.id, label: model.name })) },
      },
    },
  });
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error("Claude Agent SDK model discovery timed out")), 12_000);
  try {
    const rows = await Promise.race([session.supportedModels(), deadline.promise]);
    return sdkModelDefinitions(rows, catalog);
  } finally {
    clearTimeout(timer);
    gate.resolve();
    controller.abort();
    session.close();
  }
}
