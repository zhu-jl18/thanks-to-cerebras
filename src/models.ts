import {
  cachedConfig,
  cachedModelPool,
  modelCursor,
  setCachedModelPool,
  setDirtyConfig,
  setModelCursor,
} from "./state.ts";

export function normalizeModelPool(
  rawPool: readonly unknown[] | undefined,
): string[] {
  const base = Array.isArray(rawPool) ? rawPool : [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of base) {
    const name = typeof m === "string" ? m.trim() : "";
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }

  return out;
}

export function isModelNotFoundText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("no such model")
  );
}

export function isModelNotFoundPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;

  if (!("error" in payload)) return false;
  const errorValue = (payload as { error?: unknown }).error;

  if (typeof errorValue === "string") {
    return isModelNotFoundText(errorValue);
  }

  if (!errorValue || typeof errorValue !== "object") return false;

  const code = (errorValue as { code?: unknown }).code;
  if (code === "model_not_found") return true;

  const type = (errorValue as { type?: unknown }).type;
  if (type === "model_not_found") return true;

  const message = (errorValue as { message?: unknown }).message;
  if (typeof message === "string") {
    return isModelNotFoundText(message);
  }

  return false;
}

export function getNextModelFast(): string | null {
  if (cachedModelPool.length === 0) {
    return null;
  }
  const idx = modelCursor % cachedModelPool.length;
  const model = cachedModelPool[idx];
  setModelCursor((idx + 1) % cachedModelPool.length);

  if (cachedConfig) {
    cachedConfig.currentModelIndex = modelCursor;
    setDirtyConfig(true);
  }

  return model;
}

export function rebuildModelPoolCache(): void {
  setCachedModelPool(normalizeModelPool(cachedConfig?.modelPool));

  if (cachedModelPool.length > 0) {
    const idx = cachedConfig?.currentModelIndex ?? 0;
    setModelCursor(idx % cachedModelPool.length);
    return;
  }

  setModelCursor(0);
}
