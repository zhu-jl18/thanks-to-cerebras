import {
  CEREBRAS_API_URL,
  CORS_HEADERS,
  EXTERNAL_MODEL_ID,
  MAX_MODEL_NOT_FOUND_RETRIES,
  NO_CACHE_HEADERS,
  PROXY_REQUEST_TIMEOUT_MS,
} from "../constants.ts";
import { jsonError, jsonResponse } from "../http.ts";
import {
  fetchWithTimeout,
  getErrorMessage,
  isAbortError,
  safeJsonParse,
} from "../utils.ts";
import { cachedActiveKeyIds, keyCooldownUntil } from "../state.ts";
import { isProxyAuthorized, recordProxyKeyUsage } from "../auth.ts";
import {
  getNextApiKeyFast,
  markKeyCooldownFrom429,
  markKeyInvalid,
} from "../api-keys.ts";
import {
  getNextModelFast,
  isModelNotFoundPayload,
  isModelNotFoundText,
} from "../models.ts";
import { removeModelFromPool } from "../kv.ts";

export function handleModelsEndpoint(_req: Request): Response {
  const now = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: "list",
    data: [
      {
        id: EXTERNAL_MODEL_ID,
        object: "model",
        created: now,
        owned_by: "cerebras",
      },
    ],
  });
}

export async function handleProxyEndpoint(req: Request): Promise<Response> {
  const authResult = isProxyAuthorized(req);
  if (!authResult.authorized) {
    return jsonError("Unauthorized", 401);
  }

  if (authResult.keyId) {
    recordProxyKeyUsage(authResult.keyId);
  }

  try {
    const requestBody = await req.json();

    const apiKeyData = getNextApiKeyFast(Date.now());
    if (!apiKeyData) {
      const now = Date.now();
      const cooldowns = cachedActiveKeyIds
        .map((id) => keyCooldownUntil.get(id) ?? 0)
        .filter((ms) => ms > now);
      const minCooldownUntil =
        cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
      const retryAfterSeconds =
        minCooldownUntil > now
          ? Math.ceil((minCooldownUntil - now) / 1000)
          : 0;

      return jsonError(
        "没有可用的 API 密钥",
        cachedActiveKeyIds.length > 0 ? 429 : 500,
        retryAfterSeconds > 0
          ? { "Retry-After": String(retryAfterSeconds) }
          : undefined,
      );
    }

    let lastModelNotFound: {
      status: number;
      statusText: string;
      headers: Headers;
      bodyText: string;
    } | null = null;

    for (let attempt = 0; attempt < MAX_MODEL_NOT_FOUND_RETRIES; attempt++) {
      const targetModel = getNextModelFast();
      if (!targetModel) {
        return jsonError("没有可用的模型", 503);
      }
      requestBody.model = targetModel;

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
            body: JSON.stringify(requestBody),
          },
          PROXY_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        const timeout = isAbortError(error);
        const msg = timeout ? "上游请求超时" : getErrorMessage(error);
        return jsonError(msg, timeout ? 504 : 502);
      }

      if (apiResponse.status === 404) {
        const clone = apiResponse.clone();
        const bodyText = await clone.text().catch(() => "");
        const payload = safeJsonParse(bodyText);

        const modelNotFound =
          isModelNotFoundPayload(payload) || isModelNotFoundText(bodyText);

        if (modelNotFound) {
          lastModelNotFound = {
            status: apiResponse.status,
            statusText: apiResponse.statusText,
            headers: new Headers(apiResponse.headers),
            bodyText,
          };
          apiResponse.body?.cancel();

          await removeModelFromPool(targetModel, "model_not_found");
          continue;
        }
      }

      if (apiResponse.status === 429) {
        markKeyCooldownFrom429(apiKeyData.id, apiResponse);
      }
      if (apiResponse.status === 401 || apiResponse.status === 403) {
        markKeyInvalid(apiKeyData.id);
      }

      const responseHeaders = new Headers(apiResponse.headers);
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      Object.entries(NO_CACHE_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });

      return new Response(apiResponse.body, {
        status: apiResponse.status,
        statusText: apiResponse.statusText,
        headers: responseHeaders,
      });
    }

    if (lastModelNotFound) {
      const responseHeaders = new Headers(lastModelNotFound.headers);
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      Object.entries(NO_CACHE_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });

      return new Response(lastModelNotFound.bodyText, {
        status: lastModelNotFound.status,
        statusText: lastModelNotFound.statusText,
        headers: responseHeaders,
      });
    }

    return jsonError("模型不可用", 502);
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
