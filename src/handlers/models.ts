import {
  CEREBRAS_API_URL,
  MODEL_CATALOG_TTL_MS,
  UPSTREAM_TEST_TIMEOUT_MS,
} from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import {
  fetchWithTimeout,
  getErrorMessage,
  isAbortError,
  safeJsonParse,
} from "../utils.ts";
import { cachedKeysById, cachedModelCatalog } from "../state.ts";
import {
  isModelCatalogFresh,
  kvGetConfig,
  kvGetModelCatalog,
  kvUpdateConfig,
  kvUpdateKey,
  refreshModelCatalog,
  removeModelFromPool,
} from "../kv.ts";
import {
  isModelNotFoundPayload,
  isModelNotFoundText,
  normalizeModelPool,
  rebuildModelPoolCache,
} from "../models.ts";

export async function handleModelRoutes(
  req: Request,
  path: string,
): Promise<Response | null> {
  // Model catalog
  if (req.method === "GET" && path === "/api/models/catalog") {
    const now = Date.now();

    let catalog = cachedModelCatalog;
    if (!catalog || !isModelCatalogFresh(catalog, now)) {
      const kvCatalog = await kvGetModelCatalog();
      if (kvCatalog) {
        catalog = kvCatalog;
      }
    }

    let stale = true;
    let lastError: string | undefined;

    if (catalog && isModelCatalogFresh(catalog, now)) {
      stale = false;
    } else {
      try {
        catalog = await refreshModelCatalog();
        stale = false;
      } catch (error) {
        lastError = getErrorMessage(error);
        stale = true;
      }
    }

    if (!catalog) {
      return problemResponse(lastError ?? "无法获取模型目录", {
        status: 502,
        instance: path,
      });
    }

    return jsonResponse({
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      ttlMs: MODEL_CATALOG_TTL_MS,
      stale,
      ...(lastError ? { lastError } : {}),
      models: catalog.models,
    });
  }

  if (req.method === "POST" && path === "/api/models/catalog/refresh") {
    let catalog = cachedModelCatalog ?? (await kvGetModelCatalog());

    try {
      catalog = await refreshModelCatalog();
      return jsonResponse({
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        ttlMs: MODEL_CATALOG_TTL_MS,
        stale: false,
        models: catalog.models,
      });
    } catch (error) {
      const lastError = getErrorMessage(error);
      if (!catalog) {
        return problemResponse(lastError, { status: 502, instance: path });
      }
      return jsonResponse({
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        ttlMs: MODEL_CATALOG_TTL_MS,
        stale: true,
        lastError,
        models: catalog.models,
      });
    }
  }

  // Model pool management
  if (req.method === "GET" && path === "/api/models") {
    const config = await kvGetConfig();
    const models = normalizeModelPool(config.modelPool);
    return jsonResponse({ models });
  }

  if (req.method === "PUT" && path === "/api/models") {
    try {
      const body = await req.json().catch(() => ({}));
      const raw = (body as { models?: unknown }).models;
      if (!Array.isArray(raw)) {
        return problemResponse("models 必须为字符串数组", {
          status: 400,
          instance: path,
        });
      }

      const seen = new Set<string>();
      const models = raw
        .map((m) => (typeof m === "string" ? m.trim() : ""))
        .filter((m) => m.length > 0)
        .filter((m) => {
          if (seen.has(m)) return false;
          seen.add(m);
          return true;
        });

      if (models.length === 0) {
        return problemResponse("模型池不能为空", {
          status: 400,
          instance: path,
        });
      }

      await kvUpdateConfig((config) => ({
        ...config,
        modelPool: models,
        currentModelIndex: 0,
        schemaVersion: "5.0",
      }));
      rebuildModelPoolCache();

      return jsonResponse({ success: true, models });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path,
      });
    }
  }

  // Model test
  if (
    req.method === "POST" &&
    path.startsWith("/api/models/") &&
    path.endsWith("/test")
  ) {
    const parts = path.split("/");
    const encodedName = parts[3];
    if (!encodedName) {
      return problemResponse("缺少模型名称", {
        status: 400,
        instance: path,
      });
    }

    let modelName: string;
    try {
      modelName = decodeURIComponent(encodedName);
    } catch (_error) {
      return problemResponse("模型名称 URL 编码非法", {
        status: 400,
        instance: path,
      });
    }

    const activeKey = Array.from(cachedKeysById.values()).find(
      (k) => k.status === "active",
    );
    if (!activeKey) {
      return problemResponse("没有可用的 API 密钥", {
        status: 400,
        instance: path,
      });
    }

    try {
      const response = await fetchWithTimeout(
        CEREBRAS_API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${activeKey.key}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 1,
          }),
        },
        UPSTREAM_TEST_TIMEOUT_MS,
      );

      if (response.ok) {
        return jsonResponse({ success: true, status: "available" });
      }

      if (response.status === 404) {
        const clone = response.clone();
        const bodyText = await clone.text().catch(() => "");
        const payload = safeJsonParse(bodyText);
        const modelNotFound = isModelNotFoundPayload(payload) ||
          isModelNotFoundText(bodyText);

        if (modelNotFound) {
          await removeModelFromPool(modelName, "model_not_found");
          return jsonResponse({
            success: false,
            status: "model_not_found",
            error: "model_not_found",
          });
        }
      }

      if (response.status === 401 || response.status === 403) {
        await kvUpdateKey(activeKey.id, { status: "invalid" });
      }

      return jsonResponse({
        success: false,
        status: "unavailable",
        error: `HTTP ${response.status}`,
      });
    } catch (error) {
      const msg = isAbortError(error) ? "请求超时" : getErrorMessage(error);
      return jsonResponse({ success: false, status: "error", error: msg });
    }
  }

  return null;
}
