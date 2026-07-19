import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import { maskKey, parseBatchInput } from "../utils.ts";
import {
  kvAddKey,
  kvDeleteKey,
  kvGetAllKeys,
  type AddApiKeyResult,
  type DeleteApiKeyResult,
} from "../kv/api-keys.ts";
import { testKey } from "../services/api-keys.ts";
import { logger } from "../logger.ts";
import type { Router } from "../router.ts";

async function listApiKeys(): Promise<Response> {
  const keys = await kvGetAllKeys();
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const keyMetadata = keys.map((key) => ({
    id: key.id,
    useCount: key.useCount,
    lastUsed: key.lastUsed,
    status: key.status,
    createdAt: key.createdAt,
  }));
  return adminJsonResponse({ keys: keyMetadata });
}

function describeAddFailure(
  code: Extract<AddApiKeyResult, { ok: false }>["code"],
): { message: string; status: number } {
  switch (code) {
    case "duplicate":
      return { message: "密钥已存在", status: 409 };
    case "conflict":
      return { message: "密钥保存冲突，请重试", status: 409 };
  }
}

function describeDeleteFailure(
  code: Extract<DeleteApiKeyResult, { ok: false }>["code"],
): { message: string; status: number } {
  switch (code) {
    case "not-found":
      return { message: "密钥不存在", status: 404 };
    case "conflict":
      return { message: "密钥删除冲突，请重试", status: 409 };
    case "store-corrupt":
      return { message: "密钥存储状态异常", status: 500 };
  }
}

async function addApiKey(req: Request): Promise<Response> {
  try {
    const { key } = await req.json();
    if (!key) {
      return adminProblemResponse("密钥不能为空", {
        status: 400,
        instance: "/api/keys",
      });
    }

    const result = await kvAddKey(key);
    if (!result.ok) {
      const failure = describeAddFailure(result.code);
      return adminProblemResponse(failure.message, {
        status: failure.status,
        instance: "/api/keys",
      });
    }

    return adminJsonResponse({ success: true, id: result.id }, { status: 201 });
  } catch (error) {
    logger.error("api_key_create_failed", {}, error);
    return adminProblemResponse("请求处理失败", {
      status: 400,
      instance: "/api/keys",
    });
  }
}

async function batchImportApiKeys(req: Request): Promise<Response> {
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
      return adminProblemResponse("输入不能为空", {
        status: 400,
        instance: "/api/keys/batch",
      });
    }

    const keys = parseBatchInput(input);
    const results = {
      success: [] as string[],
      failed: [] as { key: string; error: string }[],
    };

    for (const key of keys) {
      const result = await kvAddKey(key);
      if (result.ok) {
        results.success.push(maskKey(key));
      } else {
        results.failed.push({
          key: maskKey(key),
          error: describeAddFailure(result.code).message,
        });
      }
    }

    return adminJsonResponse({
      summary: {
        total: keys.length,
        success: results.success.length,
        failed: results.failed.length,
      },
      results,
    });
  } catch (error) {
    logger.error("api_key_batch_import_failed", {}, error);
    return adminProblemResponse("请求处理失败", {
      status: 400,
      instance: "/api/keys/batch",
    });
  }
}

function exportAllApiKeys(): Response {
  return adminProblemResponse("密钥明文导出已禁用", {
    status: 403,
    instance: "/api/keys/export",
  });
}

function exportApiKey(
  _req: Request,
  params: Record<string, string>,
): Response {
  return adminProblemResponse("密钥明文导出已禁用", {
    status: 403,
    instance: `/api/keys/${params.id}/export`,
  });
}

async function deleteApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const result = await kvDeleteKey(params.id);
  if (!result.ok) {
    const failure = describeDeleteFailure(result.code);
    return adminProblemResponse(failure.message, {
      status: failure.status,
      instance: `/api/keys/${params.id}`,
    });
  }
  return adminJsonResponse({ success: true });
}

async function testApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  return adminJsonResponse(await testKey(params.id));
}

export function register(router: Router): void {
  router
    .get("/api/keys", listApiKeys)
    .post("/api/keys", addApiKey)
    .post("/api/keys/batch", batchImportApiKeys)
    .get("/api/keys/export", exportAllApiKeys)
    .get("/api/keys/:id/export", exportApiKey)
    .delete("/api/keys/:id", deleteApiKey)
    .post("/api/keys/:id/test", testApiKey);
}