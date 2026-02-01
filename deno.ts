// deno.ts - Cerebras API 代理与密钥管理系统
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

import { CORS_HEADERS } from "./src/constants.ts";
import { problemResponse } from "./src/http.ts";
import { cachedConfig } from "./src/state.ts";
import { isAdminAuthorized } from "./src/auth.ts";
import { applyKvFlushInterval, bootstrapCache } from "./src/kv.ts";

// Handlers
import { handleAuthRoutes } from "./src/handlers/auth.ts";
import { handleProxyKeyRoutes } from "./src/handlers/proxy-keys.ts";
import { handleApiKeyRoutes } from "./src/handlers/api-keys.ts";
import { handleModelRoutes } from "./src/handlers/models.ts";
import { handleConfigRoutes } from "./src/handlers/config.ts";
import {
  handleModelsEndpoint,
  handleProxyEndpoint,
} from "./src/handlers/proxy.ts";
import { renderAdminPage } from "./src/ui/admin.ts";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Auth routes (no login required)
  if (path.startsWith("/api/auth/")) {
    const response = await handleAuthRoutes(req, path);
    if (response) return response;
    return problemResponse("Not Found", { status: 404, instance: path });
  }

  // Protected admin API routes
  if (path.startsWith("/api/")) {
    if (!(await isAdminAuthorized(req))) {
      return problemResponse("未登录", { status: 401, instance: path });
    }

    // Proxy keys management
    const proxyKeyResponse = await handleProxyKeyRoutes(req, path);
    if (proxyKeyResponse) return proxyKeyResponse;

    // API keys management
    const apiKeyResponse = await handleApiKeyRoutes(req, path);
    if (apiKeyResponse) return apiKeyResponse;

    // Model management
    const modelResponse = await handleModelRoutes(req, path);
    if (modelResponse) return modelResponse;

    // Config and stats
    const configResponse = await handleConfigRoutes(req, path);
    if (configResponse) return configResponse;

    return problemResponse("Not Found", { status: 404, instance: path });
  }

  // GET /v1/models - OpenAI compatible
  if (req.method === "GET" && path === "/v1/models") {
    return handleModelsEndpoint(req);
  }

  // POST /v1/chat/completions - Proxy
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return await handleProxyEndpoint(req);
  }

  // Admin panel
  if (path === "/" && req.method === "GET") {
    return await renderAdminPage();
  }

  return new Response("Not Found", { status: 404 });
}

// ================================
// 启动服务器
// ================================
console.log(`Cerebras Proxy 启动`);
console.log(`- 管理面板: /`);
console.log(`- API 代理: /v1/chat/completions`);
console.log(`- 模型接口: /v1/models`);
console.log(`- 存储: Deno KV`);

if (import.meta.main) {
  await bootstrapCache();
  applyKvFlushInterval(cachedConfig);
  serve(handler);
}
