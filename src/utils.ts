import {
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  MIN_KV_FLUSH_INTERVAL_MS,
} from "./constants.ts";

export function generateId(): string {
  return crypto.randomUUID();
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return (
    key.substring(0, 4) +
    "*".repeat(key.length - 8) +
    key.substring(key.length - 4)
  );
}

export function parseBatchInput(input: string): string[] {
  return input
    .split(/[\n,\s]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return (error as { name?: unknown }).name === "AbortError";
  }
  return false;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(0, timeoutMs),
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function safeJsonParse(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function normalizeKvFlushIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_KV_FLUSH_INTERVAL_MS;
  return Math.max(MIN_KV_FLUSH_INTERVAL_MS, Math.trunc(ms));
}
