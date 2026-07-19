import { PROXY_KEY_AUTH_REFRESH_INTERVAL_MS } from "./constants.ts";
import { state } from "./state.ts";
import { kvMergeAllApiKeysIntoCache, kvUpdateKey } from "./kv/api-keys.ts";
import {
  getApiKeyCacheRevision,
  recordApiKeyCacheRevision,
} from "./kv/revisions.ts";
import { logger } from "./logger.ts";

export function rebuildActiveKeyIds(): void {
  const keys = Array.from(state.cachedKeysById.values());
  keys.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  state.cachedActiveKeyIds = keys.filter((key) => key.status === "active").map(
    (key) => key.id,
  );
  if (state.cachedActiveKeyIds.length === 0) {
    state.cachedCursor = 0;
    return;
  }
  state.cachedCursor = state.cachedCursor % state.cachedActiveKeyIds.length;
}

export function getNextApiKeyFast(
  now: number,
): { key: string; id: string } | null {
  if (state.cachedActiveKeyIds.length === 0) return null;

  for (let offset = 0; offset < state.cachedActiveKeyIds.length; offset++) {
    const index = (state.cachedCursor + offset) %
      state.cachedActiveKeyIds.length;
    const id = state.cachedActiveKeyIds[index];
    const cooldownUntil = state.keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;

    const keyEntry = state.cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== "active") continue;
    if (!keyEntry.key) {
      throw new Error(`API key ${id} 未解密`);
    }

    state.cachedCursor = (index + 1) % state.cachedActiveKeyIds.length;

    keyEntry.useCount += 1;
    keyEntry.lastUsed = now;
    state.dirtyKeyIds.add(id);

    if (state.cachedConfig) {
      state.addPendingTotalRequests(1);
      state.dirtyConfig = true;
    }

    return { key: keyEntry.key, id };
  }

  return null;
}

export async function refreshApiKeyCacheIfChanged(): Promise<void> {
  if (state.apiKeyCacheRevisionRefreshInFlight) {
    return await state.apiKeyCacheRevisionRefreshInFlight;
  }
  const refresh = refreshApiKeyCacheRevision();
  state.apiKeyCacheRevisionRefreshInFlight = refresh;
  try {
    await refresh;
  } finally {
    state.apiKeyCacheRevisionRefreshInFlight = null;
  }
}

async function refreshApiKeyCacheRevision(): Promise<void> {
  const now = Date.now();
  if (
    now - state.apiKeyCacheRevisionLastCheckedAt <
      PROXY_KEY_AUTH_REFRESH_INTERVAL_MS
  ) {
    return;
  }
  // Bump the throttle clock first so a sustained KV outage cannot turn the
  // throttle window into a per-request retry storm. With this in place the
  // proxy keeps serving from its existing cache for up to
  // PROXY_KEY_AUTH_REFRESH_INTERVAL_MS without hitting KV again, even if
  // every refresh attempt fails. See issue #138.
  state.apiKeyCacheRevisionLastCheckedAt = now;
  // Track which phase failed so the warn log distinguishes a KV outage on
  // the revision read from a failure inside the merge step.
  let phase: "revision_read" | "merge_keys" = "revision_read";
  try {
    const revision = await getApiKeyCacheRevision();
    if (revision === state.apiKeyCacheRevision) return;
    phase = "merge_keys";
    await kvMergeAllApiKeysIntoCache();
    recordApiKeyCacheRevision(revision);
  } catch (error) {
    // Preserve the last verified in-memory cache when KV is unavailable or the
    // persisted record/claim invariant cannot be validated.
    logger.warn("api_key_cache_refresh_failed", { phase }, error);
  }
}

export function markKeyCooldownFrom429(id: string, response: Response): void {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
    ? Number.parseInt(retryAfter, 10) * 1000
    : 2000;
  state.keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}

export async function markKeyInvalid(id: string): Promise<void> {
  const keyEntry = state.cachedKeysById.get(id);
  if (!keyEntry || keyEntry.status === "invalid") return;

  keyEntry.status = "invalid";
  state.keyCooldownUntil.delete(id);
  rebuildActiveKeyIds();
  try {
    await kvUpdateKey(id, { status: "invalid" });
  } catch (error) {
    logger.error("api_key_invalidation_write_failed", { keyId: id }, error);
  }
}
