import { getNextApiKeyFast, refreshApiKeyCacheIfChanged } from "../api-keys.ts";
import { PROXY_KEY_AUTH_REFRESH_INTERVAL_MS } from "../constants.ts";
import { kvMergeAllApiKeysIntoCache } from "../kv/api-keys.ts";
import { logger } from "../logger.ts";
import { metrics } from "../metrics.ts";
import { state } from "../state.ts";

type SelectedApiKey = NonNullable<ReturnType<typeof getNextApiKeyFast>>;

export type ProxyApiKeySelection =
  | { ok: true; key: SelectedApiKey }
  | { ok: false; status: number; retryAfterSec?: number };

export async function selectProxyApiKey(
  context: Readonly<Record<string, string | undefined>>,
): Promise<ProxyApiKeySelection> {
  const now = Date.now();
  const emptyPoolVerificationDue =
    now - state.apiKeyCacheRevisionLastCheckedAt >=
      PROXY_KEY_AUTH_REFRESH_INTERVAL_MS;
  const revisionBeforeRefresh = state.apiKeyCacheRevision;

  await refreshApiKeyCacheIfChanged();
  const cached = getNextApiKeyFast(Date.now());
  if (cached) return { ok: true, key: cached };

  const cacheContainsActiveKeys = state.cachedActiveKeyIds.length > 0;
  const revisionRefreshLoadedChanges =
    state.apiKeyCacheRevision !== revisionBeforeRefresh;
  if (
    cacheContainsActiveKeys ||
    !emptyPoolVerificationDue ||
    revisionRefreshLoadedChanges
  ) {
    return noApiKeySelection();
  }

  try {
    await kvMergeAllApiKeysIntoCache();
  } catch (error) {
    // Strict verification still rejects malformed record/claim state. The
    // request path contains that failure and keeps the last verified cache.
    logger.warn(
      "api_key_cache_refresh_failed",
      { ...context, phase: "empty_pool_merge" },
      error,
    );
  }

  const refreshed = getNextApiKeyFast(Date.now());
  if (refreshed) return { ok: true, key: refreshed };
  return noApiKeySelection();
}

function noApiKeySelection(): ProxyApiKeySelection {
  const now = Date.now();
  const cooldowns = state.cachedActiveKeyIds
    .map((id) => state.keyCooldownUntil.get(id) ?? 0)
    .filter((milliseconds) => milliseconds > now);
  const minCooldownUntil = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
  const retryAfterSec = minCooldownUntil > now
    ? Math.ceil((minCooldownUntil - now) / 1000)
    : 0;
  const status = state.cachedActiveKeyIds.length > 0 ? 429 : 500;

  metrics.inc(
    "proxy_requests_total",
    status === 429 ? "no_key_cooldown" : "no_key",
  );
  return {
    ok: false,
    status,
    retryAfterSec: retryAfterSec > 0 ? retryAfterSec : undefined,
  };
}
