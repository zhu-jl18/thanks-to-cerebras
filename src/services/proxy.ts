import {
  CEREBRAS_API_URL,
  CORS_HEADERS,
  MAX_MODEL_NOT_FOUND_RETRIES,
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  NO_CACHE_HEADERS,
  PROXY_REQUEST_TIMEOUT_MS,
  UPSTREAM_ERROR_BODY_TIMEOUT_MS,
} from "../constants.ts";
import { fetchWithTimeout, isAbortError, safeJsonParse } from "../utils.ts";
import { state } from "../state.ts";
import {
  getNextApiKeyFast,
  markKeyCooldownFrom429,
  markKeyInvalid,
  refreshApiKeyCacheIfChanged,
} from "../api-keys.ts";
import {
  getNextModelFast,
  isModelNotFoundPayload,
  isModelNotFoundText,
} from "../models.ts";
import { kvMergeAllApiKeysIntoCache } from "../kv/api-keys.ts";
import { removeModelFromPool } from "../kv/model-catalog.ts";
import { metrics } from "../metrics.ts";
import { logger } from "../logger.ts";
import {
  getUpstreamCircuitPermit,
  recordUpstreamFailure,
  recordUpstreamSuccess,
} from "./upstream-circuit-breaker.ts";

export type ProxyResult =
  | {
    kind: "upstream";
    body: ReadableStream<Uint8Array> | null;
    status: number;
    statusText: string;
    headers: Headers;
  }
  | {
    kind: "error";
    message: string;
    status: number;
    code?: string;
    retryAfterSec?: number;
    headers?: Headers;
  };

type ProxyLogContext = Record<string, string | undefined>;

function applyStandardHeaders(headers: Headers): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(NO_CACHE_HEADERS)) {
    headers.set(key, value);
  }
}

function buildSanitizedUpstreamError(response: Response): ProxyResult {
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  applyStandardHeaders(headers);
  return {
    kind: "error",
    message: "Upstream request failed",
    status: response.status,
    code: "upstream_error",
    headers,
  };
}

async function readBoundedBodyText(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = body?.getReader();
  if (!reader) return { ok: true, text: "" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(
      () => resolve("timeout"),
      UPSTREAM_ERROR_BODY_TIMEOUT_MS,
    );
  });

  try {
    while (true) {
      const read = reader.read();
      const result = await Promise.race([read, timeout]);
      if (result === "timeout") {
        read.catch(() => {});
        await reader.cancel("upstream error body timeout");
        return { ok: false };
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_UPSTREAM_ERROR_BODY_BYTES) {
        await reader.cancel("upstream error body too large");
        return { ok: false };
      }
      chunks.push(result.value);
    }
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

async function discardBoundedUpstreamErrorBody(
  response: Response,
): Promise<void> {
  await readBoundedBodyText(response.body);
}

/**
 * Classifies an upstream response for the circuit breaker:
 * - 5xx: counts as a failure and bumps the breaker.
 * - 2xx: counts as a success and closes the breaker.
 * - 4xx: ignored — it's a client/upstream-classification error, not an
 *   outage. Treating 4xx as success would let intermittent 429s reset the
 *   failure counter and prevent the breaker from ever opening under mixed
 *   5xx + 429 traffic. See issue #137.
 */
function recordCircuitOutcome(status: number): void {
  if (status >= 500) {
    recordUpstreamFailure();
    metrics.inc("upstream_responses_total", "5xx");
  } else if (status >= 200 && status < 300) {
    recordUpstreamSuccess();
  }
}

export async function forwardChatCompletion(
  requestBody: Record<string, unknown>,
  context: ProxyLogContext = {},
): Promise<ProxyResult> {
  await refreshApiKeyCacheIfChanged();
  let apiKeyData = getNextApiKeyFast(Date.now());
  if (!apiKeyData) {
    try {
      await kvMergeAllApiKeysIntoCache();
    } catch (error) {
      // A forced refresh must preserve the last verified cache just like the
      // revision-driven refresh path. Persistent invariant failures are logged
      // but must not escape through the proxy request path.
      logger.warn(
        "api_key_cache_refresh_failed",
        { ...context, phase: "empty_pool_merge" },
        error,
      );
    }
    apiKeyData = getNextApiKeyFast(Date.now());
  }
  if (!apiKeyData) {
    const now = Date.now();
    const cooldowns = state.cachedActiveKeyIds
      .map((id) => state.keyCooldownUntil.get(id) ?? 0)
      .filter((ms) => ms > now);
    const minCooldownUntil = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
    const retryAfterSec = minCooldownUntil > now
      ? Math.ceil((minCooldownUntil - now) / 1000)
      : 0;

    const status = state.cachedActiveKeyIds.length > 0 ? 429 : 500;
    const outcome = status === 429 ? "no_key_cooldown" : "no_key";
    metrics.inc("proxy_requests_total", outcome);
    return {
      kind: "error",
      message: "没有可用的 API 密钥",
      status,
      retryAfterSec: retryAfterSec > 0 ? retryAfterSec : undefined,
    };
  }

  let sawModelNotFound = false;

  for (let attempt = 0; attempt < MAX_MODEL_NOT_FOUND_RETRIES; attempt++) {
    const targetModel = getNextModelFast();
    if (!targetModel) {
      metrics.inc("proxy_requests_total", "no_model");
      return { kind: "error", message: "没有可用的模型", status: 503 };
    }
    const body = { ...requestBody, model: targetModel };

    const circuitPermit = getUpstreamCircuitPermit();
    if (!circuitPermit.allowed) {
      const headers = new Headers({
        "Retry-After": String(circuitPermit.retryAfterSec),
      });
      applyStandardHeaders(headers);
      metrics.inc("proxy_requests_total", "upstream_circuit_open");
      return {
        kind: "error",
        message: "上游服务暂时不可用",
        status: 503,
        code: "upstream_circuit_open",
        headers,
      };
    }

    let apiResponse: Response;
    try {
      apiResponse = await fetchWithTimeout(
        CEREBRAS_API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeyData.key}`,
          },
          body: JSON.stringify(body),
        },
        PROXY_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (isAbortError(error)) {
        recordUpstreamFailure();
        metrics.inc("proxy_requests_total", "timeout");
        metrics.inc("upstream_responses_total", "timeout");
        return { kind: "error", message: "上游请求超时", status: 504 };
      }
      recordUpstreamFailure();
      logger.error("proxy_upstream_fetch_failed", context, error);
      metrics.inc("proxy_requests_total", "upstream_error");
      metrics.inc("upstream_responses_total", "network_error");
      return { kind: "error", message: "上游请求失败", status: 502 };
    }

    recordCircuitOutcome(apiResponse.status);

    let upstreamErrorBodyConsumed = false;

    if (apiResponse.status === 404) {
      const bodyRead = await readBoundedBodyText(apiResponse.body);
      upstreamErrorBodyConsumed = true;
      if (!bodyRead.ok) {
        metrics.inc("upstream_responses_total", "404_body_too_large");
        metrics.inc("proxy_requests_total", "upstream_error");
        return buildSanitizedUpstreamError(apiResponse);
      }
      const payload = safeJsonParse(bodyRead.text);

      const modelNotFound = isModelNotFoundPayload(payload) ||
        isModelNotFoundText(bodyRead.text);

      if (modelNotFound) {
        sawModelNotFound = true;
        apiResponse.body?.cancel();
        metrics.inc("upstream_responses_total", "404_model_not_found");
        await removeModelFromPool(targetModel, "model_not_found");
        continue;
      }
    }

    if (!apiResponse.ok) {
      if (!upstreamErrorBodyConsumed) {
        await discardBoundedUpstreamErrorBody(apiResponse);
      }
      if (apiResponse.status === 429) {
        markKeyCooldownFrom429(apiKeyData.id, apiResponse);
        metrics.inc("upstream_responses_total", "429");
      } else if (apiResponse.status === 401 || apiResponse.status === 403) {
        await markKeyInvalid(apiKeyData.id);
        metrics.inc(
          "upstream_responses_total",
          apiResponse.status === 401 ? "401" : "403",
        );
      } else {
        metrics.inc("upstream_responses_total", "other");
      }
      metrics.inc("proxy_requests_total", "upstream_error");
      return buildSanitizedUpstreamError(apiResponse);
    }
    metrics.inc("upstream_responses_total", "2xx");

    const responseHeaders = new Headers(apiResponse.headers);
    applyStandardHeaders(responseHeaders);

    metrics.inc("proxy_requests_total", "success");
    return {
      kind: "upstream",
      body: apiResponse.body,
      status: apiResponse.status,
      statusText: apiResponse.statusText,
      headers: responseHeaders,
    };
  }

  if (sawModelNotFound) {
    metrics.inc("proxy_requests_total", "no_model");
    return { kind: "error", message: "模型不可用", status: 502 };
  }

  metrics.inc("proxy_requests_total", "no_model");
  return { kind: "error", message: "模型不可用", status: 502 };
}
