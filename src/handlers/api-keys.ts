import {
  CEREBRAS_API_URL,
  FALLBACK_MODEL,
  UPSTREAM_TEST_TIMEOUT_MS,
} from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import {
  fetchWithTimeout,
  getErrorMessage,
  isAbortError,
  maskKey,
  parseBatchInput,
  safeJsonParse,
} from "../utils.ts";
import { cachedKeysById, cachedModelPool } from "../state.ts";
import {
  kvAddKey,
  kvDeleteKey,
  kvGetAllKeys,
  kvUpdateKey,
  removeModelFromPool,
} from "../kv.ts";
import { isModelNotFoundPayload, isModelNotFoundText } from "../models.ts";

export async function testKey(
  id: string,
): Promise<{ success: boolean; status: string; error?: string }> {
  const apiKey = cachedKeysById.get(id);

  if (!apiKey) {
    return { success: false, status: "invalid", error: "密钥不存在" };
  }

  const testModel =
    cachedModelPool.length > 0 ? cachedModelPool[0] : FALLBACK_MODEL;

  try {
    const response = await fetchWithTimeout(
      CEREBRAS_API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.key}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1,
        }),
      },
      UPSTREAM_TEST_TIMEOUT_MS,
    );

    if (response.ok) {
      await kvUpdateKey(id, { status: "active" });
      return { success: true, status: "active" };
    }

    if (response.status === 401 || response.status === 403) {
      await kvUpdateKey(id, { status: "invalid" });
      return {
        success: false,
        status: "invalid",
        error: `HTTP ${response.status}`,
      };
    }

    if (response.status === 404) {
      const clone = response.clone();
      const bodyText = await clone.text().catch(() => "");
      const payload = safeJsonParse(bodyText);
      const modelNotFound =
        isModelNotFoundPayload(payload) || isModelNotFoundText(bodyText);

      if (modelNotFound) {
        await removeModelFromPool(testModel, "model_not_found");
        await kvUpdateKey(id, { status: "active" });
        return { success: true, status: "active" };
      }
    }

    await kvUpdateKey(id, { status: "inactive" });
    return {
      success: false,
      status: "inactive",
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    const msg = isAbortError(error) ? "请求超时" : getErrorMessage(error);
    await kvUpdateKey(id, { status: "inactive" });
    return { success: false, status: "inactive", error: msg };
  }
}

export async function handleApiKeyRoutes(
  req: Request,
  path: string,
): Promise<Response | null> {
  if (req.method === "GET" && path === "/api/keys") {
    const keys = await kvGetAllKeys();
    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskKey(k.key),
    }));
    return jsonResponse({ keys: maskedKeys });
  }

  if (req.method === "POST" && path === "/api/keys") {
    try {
      const { key } = await req.json();
      if (!key) {
        return problemResponse("密钥不能为空", {
          status: 400,
          instance: path,
        });
      }

      const result = await kvAddKey(key);
      if (!result.success) {
        return problemResponse(result.error ?? "添加失败", {
          status: result.error === "密钥已存在" ? 409 : 400,
          instance: path,
        });
      }

      return jsonResponse(result, { status: 201 });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path,
      });
    }
  }

  if (req.method === "POST" && path === "/api/keys/batch") {
    try {
      const contentType = req.headers.get("Content-Type") || "";
      let input: string;

      if (contentType.includes("application/json")) {
        const body = await req.json();
        input = body.input || (typeof body === "string" ? body : "");
      } else {
        input = await req.text();
      }

      if (!input?.trim()) {
        return problemResponse("输入不能为空", {
          status: 400,
          instance: path,
        });
      }

      const keys = parseBatchInput(input);
      const results = {
        success: [] as string[],
        failed: [] as { key: string; error: string }[],
      };

      for (const key of keys) {
        const result = await kvAddKey(key);
        if (result.success) {
          results.success.push(maskKey(key));
        } else {
          results.failed.push({
            key: maskKey(key),
            error: result.error || "未知错误",
          });
        }
      }

      return jsonResponse({
        summary: {
          total: keys.length,
          success: results.success.length,
          failed: results.failed.length,
        },
        results,
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path,
      });
    }
  }

  if (req.method === "GET" && path === "/api/keys/export") {
    const keys = Array.from(cachedKeysById.values());
    const rawKeys = keys.map((k) => k.key);
    return jsonResponse({ keys: rawKeys });
  }

  if (
    req.method === "GET" &&
    path.startsWith("/api/keys/") &&
    path.endsWith("/export")
  ) {
    const id = path.split("/")[3];
    const keyEntry = cachedKeysById.get(id);
    if (!keyEntry) {
      return problemResponse("密钥不存在", { status: 404, instance: path });
    }
    return jsonResponse({ key: keyEntry.key });
  }

  if (req.method === "DELETE" && path.startsWith("/api/keys/")) {
    const id = path.split("/").pop()!;
    const result = await kvDeleteKey(id);
    if (!result.success) {
      return problemResponse(result.error ?? "删除失败", {
        status: result.error === "密钥不存在" ? 404 : 400,
        instance: path,
      });
    }
    return jsonResponse(result);
  }

  if (
    req.method === "POST" &&
    path.startsWith("/api/keys/") &&
    path.endsWith("/test")
  ) {
    const id = path.split("/")[3];
    const result = await testKey(id);
    return jsonResponse(result);
  }

  return null;
}
