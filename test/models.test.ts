import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@oh-my-pi/pi-ai";
import { discoverSdkModels, sdkModelDefinitions } from "../src/models.ts";

const catalog = [
  { id: "claude-fable-5", name: "Claude Fable 5", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
] as Model[];

function option(value: string, resolvedModel = value): ModelInfo {
  return { value, resolvedModel, displayName: value, description: "" };
}

describe("exact SDK model identities", () => {
  test("moving aliases collapse into the resolved version, not an invented family model", () => {
    const models = sdkModelDefinitions([
      option("default", "claude-opus-5-5"),
      option("opus", "claude-opus-5-5"),
      option("claude-opus-5-5"),
    ], catalog);
    expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    ]);
  });

  test("Fable revisions remain independently selectable with exact version names", () => {
    const models = sdkModelDefinitions([
      option("claude-fable-5-1[1m]", "claude-fable-5-1"),
      option("claude-fable-5"),
    ], catalog);
    expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "claude-fable-5", name: "Claude Fable 5" },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    ]);
    expect(models[1]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000 });
  });

  test("SDK omissions are authoritative even when the bundled catalog offers more", () => {
    const models = sdkModelDefinitions([option("opus", "claude-opus-5-5")], catalog);
    expect(models.map(model => model.id)).toEqual(["claude-opus-5-5"]);
    expect(sdkModelDefinitions([], catalog)).toEqual([]);
  });

  test("an SDK model newer than the catalog keeps its exact identity instead of a guessed version", () => {
    const row = { ...option("opus", "claude-opus-9-2"), displayName: "Opus", supportsAdaptiveThinking: true, supportedEffortLevels: ["low", "high"] as const };
    const models = sdkModelDefinitions([{ ...row, supportedEffortLevels: [...row.supportedEffortLevels] }], catalog);
    expect(models[0]).toMatchObject({
      id: "claude-opus-9-2", name: "claude-opus-9-2", reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high"] },
    });
  });

  test("dated snapshots are not accidentally merged with each other", () => {
    const models = sdkModelDefinitions([
      option("claude-custom-4-5-20250101"),
      option("claude-custom-4-5-20250201"),
    ], []);
    expect(models.map(model => model.id)).toEqual(["claude-custom-4-5-20250101", "claude-custom-4-5-20250201"]);
  });
});

test("discovery failures close the subprocess and propagate instead of inventing fallback models", async () => {
  let closed = false;
  let signal: AbortSignal | undefined;
  const discovery = discoverSdkModels(params => {
    signal = params.options?.abortController?.signal;
    return {
      supportedModels: async () => { throw new Error("SDK authentication failed"); },
      close() { closed = true; },
    };
  });
  await expect(discovery).rejects.toThrow("SDK authentication failed");
  expect(closed).toBe(true);
  expect(signal?.aborted).toBe(true);
});
