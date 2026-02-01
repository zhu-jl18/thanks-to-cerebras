import { MAX_PROXY_KEYS } from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import { getErrorMessage, maskKey } from "../utils.ts";
import { cachedProxyKeys } from "../state.ts";
import { kvAddProxyKey, kvDeleteProxyKey } from "../kv.ts";

export async function handleProxyKeyRoutes(
  req: Request,
  path: string,
): Promise<Response | null> {
  if (req.method === "GET" && path === "/api/proxy-keys") {
    const keys = Array.from(cachedProxyKeys.values());
    const masked = keys.map((k) => ({
      id: k.id,
      key: maskKey(k.key),
      name: k.name,
      useCount: k.useCount,
      lastUsed: k.lastUsed,
      createdAt: k.createdAt,
    }));
    return jsonResponse({
      keys: masked,
      maxKeys: MAX_PROXY_KEYS,
      authEnabled: cachedProxyKeys.size > 0,
    });
  }

  if (req.method === "POST" && path === "/api/proxy-keys") {
    try {
      const { name } = await req.json().catch(() => ({ name: "" }));
      const result = await kvAddProxyKey(name);
      if (!result.success) {
        return problemResponse(result.error ?? "创建失败", {
          status: 400,
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

  if (req.method === "DELETE" && path.startsWith("/api/proxy-keys/")) {
    const id = path.split("/").pop()!;
    const result = await kvDeleteProxyKey(id);
    if (!result.success) {
      return problemResponse(result.error ?? "删除失败", {
        status: result.error === "密钥不存在" ? 404 : 400,
        instance: path,
      });
    }
    return jsonResponse(result);
  }

  if (
    req.method === "GET" &&
    path.startsWith("/api/proxy-keys/") &&
    path.endsWith("/export")
  ) {
    const id = path.split("/")[3];
    const pk = cachedProxyKeys.get(id);
    if (!pk) {
      return problemResponse("密钥不存在", { status: 404, instance: path });
    }
    return jsonResponse({ key: pk.key });
  }

  return null;
}
