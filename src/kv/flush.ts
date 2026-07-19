// ── Write Strategy ──
// Immediate KV writes: all user-initiated CRUD (add/delete/update keys,
//   proxy keys, config CAS, auth tokens, model catalog, markKeyInvalid).
// Dirty + flush (this module): hot-path stats only — useCount, lastUsed,
//   totalRequests. These are batched via a periodic timer to avoid
//   per-request KV overhead on the proxy critical path.

import type { ProxyAuthKey, ProxyConfig } from "../types.ts";
import { PROXY_KEY_PREFIX } from "../constants.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { rebuildModelPoolCache } from "../models.ts";
import { state } from "../state.ts";
import {
  kvGetConfig,
  kvUpdateConfig,
  resolveKvFlushIntervalMs,
} from "./config.ts";
import { kvGetAllKeys, kvMergeApiKeyUsage } from "./api-keys.ts";
import { kvGetAllProxyKeys } from "./proxy-keys.ts";
import { getApiKeyCacheRevision, getAuthCacheRevision } from "./revisions.ts";
import { metrics } from "../metrics.ts";
import { logger } from "../logger.ts";

export { resolveKvFlushIntervalMs } from "./config.ts";

/**
 * Applies the configured KV flush interval by replacing the existing timer.
 */
export function applyKvFlushInterval(config: ProxyConfig | null): void {
  state.kvFlushIntervalMsEffective = resolveKvFlushIntervalMs(config);

  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  state.kvFlushTimerId = setInterval(
    flushDirtyToKv,
    state.kvFlushIntervalMsEffective,
  );
}

/**
 * Merges cached API-key usage counters without overwriting CRUD changes.
 * A concurrent delete wins permanently; a concurrent update is retried later.
 */
async function flushApiKeyStats(id: string): Promise<void> {
  const keyEntry = state.cachedKeysById.get(id);
  if (!keyEntry) return;

  const result = await kvMergeApiKeyUsage(
    id,
    keyEntry.useCount,
    keyEntry.lastUsed,
  );
  if (result === "conflict") state.dirtyKeyIds.add(id);
}

/**
 * Merges cached proxy-key usage counters without overwriting CRUD changes.
 * A concurrent delete wins permanently; a concurrent update is retried later.
 */
async function flushProxyKeyStats(id: string): Promise<void> {
  const proxyKey = state.cachedProxyKeys?.get(id);
  if (!proxyKey) return;

  const key = [...PROXY_KEY_PREFIX, id];
  const entry = await state.kv.get<ProxyAuthKey>(key);
  const persisted = entry.value;
  if (persisted === null) return;

  const result = await state.kv.atomic()
    .check(entry)
    .set(key, {
      ...persisted,
      useCount: Math.max(persisted.useCount, proxyKey.useCount),
      lastUsed: Math.max(persisted.lastUsed ?? 0, proxyKey.lastUsed ?? 0) ||
        undefined,
    })
    .commit();

  if (result.ok) return;

  const latest = await state.kv.get<ProxyAuthKey>(key);
  if (latest.value !== null) {
    state.dirtyProxyKeyIds.add(id);
  }
}

/**
 * Flushes batched hot-path counters to KV without overwriting immediate CRUD writes.
 */
export async function flushDirtyToKv(): Promise<void> {
  const now = Date.now();
  for (const [id, until] of state.keyCooldownUntil) {
    if (until < now) {
      state.keyCooldownUntil.delete(id);
    }
  }

  if (state.flushInProgress) return;
  if (
    !state.dirtyConfig && state.dirtyKeyIds.size === 0 &&
    state.dirtyProxyKeyIds.size === 0
  ) {
    return;
  }
  if (!state.cachedConfig) return;

  state.flushInProgress = true;
  const keyIds = Array.from(state.dirtyKeyIds);
  state.dirtyKeyIds.clear();
  const proxyKeyIds = Array.from(state.dirtyProxyKeyIds);
  state.dirtyProxyKeyIds.clear();
  const flushConfig = state.dirtyConfig;
  state.dirtyConfig = false;
  const pendingRequestsSnapshot = state.pendingTotalRequests;

  try {
    try {
      const tasks: Promise<unknown>[] = [];
      for (const id of keyIds) {
        tasks.push(flushApiKeyStats(id));
      }
      for (const id of proxyKeyIds) {
        tasks.push(flushProxyKeyStats(id));
      }
      await Promise.all(tasks);
    } catch (error) {
      for (const id of keyIds) state.dirtyKeyIds.add(id);
      for (const id of proxyKeyIds) state.dirtyProxyKeyIds.add(id);
      state.dirtyConfig = state.dirtyConfig || flushConfig;
      metrics.inc("flush_total", "failure");
      logger.error("kv_stats_flush_failed", {}, error);
      return;
    }

    if (!flushConfig || pendingRequestsSnapshot <= 0) {
      metrics.inc("flush_total", "success");
      return;
    }

    try {
      await kvUpdateConfig((config) => ({
        ...config,
        totalRequests: (config.totalRequests ?? 0) + pendingRequestsSnapshot,
      }));
      state.subtractPendingTotalRequests(pendingRequestsSnapshot);
      rebuildModelPoolCache();
      metrics.inc("flush_total", "success");
    } catch (error) {
      state.dirtyConfig = true;
      metrics.inc("flush_total", "failure");
      logger.error("kv_config_flush_failed", {}, error);
    }
  } finally {
    state.flushInProgress = false;
  }
}

/**
 * Loads persisted config and key records into the hot-path in-memory caches.
 * API-key loading validates the record/claim bijection before decrypting any
 * value, so an incompatible or corrupt store fails startup instead of silently
 * weakening duplicate protection.
 */
export async function bootstrapCache(): Promise<void> {
  state.cachedConfig = await kvGetConfig();
  const keys = await kvGetAllKeys();
  state.cachedKeysById = new Map(keys.map((key) => [key.id, key]));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();

  const proxyKeys = await kvGetAllProxyKeys();
  state.cachedProxyKeys = new Map(proxyKeys.map((key) => [key.id, key]));
  state.proxyKeyCacheLastLoadedAt = Date.now();
  state.authCacheRevision = await getAuthCacheRevision();
  state.authCacheRevisionLastCheckedAt = Date.now();
  state.apiKeyCacheRevision = await getApiKeyCacheRevision();
  state.apiKeyCacheRevisionLastCheckedAt = Date.now();
}
