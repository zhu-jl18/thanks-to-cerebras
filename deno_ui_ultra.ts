// deno_ui_ultra.ts - Cerebras API 代理与密钥管理系统（KV 持久化版）
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// ================================
// 配置常量
// ================================
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const RATE_LIMIT_MS = 200;
const AUTH_PASSWORD = (Deno.env.get("AUTH_PASSWORD")?.trim() || '') || null;
const KV_PREFIX = "cerebras-proxy"; // KV 键前缀
const CONFIG_KEY = [KV_PREFIX, "meta", "config"] as const;
const API_KEY_PREFIX = [KV_PREFIX, "keys", "api"] as const;
const KV_ATOMIC_MAX_RETRIES = 10;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE, PUT',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ================================
// Deno KV 存储
// ================================
const kv = Deno.env.get("DENO_KV_PATH")
  ? await Deno.openKv(Deno.env.get("DENO_KV_PATH"))
  : await Deno.openKv();

// ================================
// 类型定义
// ================================
interface ApiKey {
  id: string;
  key: string;
  useCount: number;
  lastUsed?: number;
  status: 'active' | 'inactive' | 'invalid';
  createdAt: number;
}

interface ProxyConfig {
  defaultModel: string;
  currentKeyIndex: number;
  totalRequests: number;
  schemaVersion: string;
}

// ================================
// 工具函数
// ================================
function generateId(): string {
  return crypto.randomUUID();
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return key.substring(0, 4) + "*".repeat(key.length - 8) + key.substring(key.length - 4);
}

function parseBatchInput(input: string): string[] {
  // 支持换行、逗号、空格分隔
  return input
    .split(/[\n,\s]+/)
    .map(k => k.trim())
    .filter(k => k.length > 0);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProxyAuthorized(req: Request): boolean {
  if (!AUTH_PASSWORD) return true;
  const token = req.headers.get("Authorization");
  if (!token || !token.startsWith("Bearer ")) return false;
  return token.substring(7).trim() === AUTH_PASSWORD;
}

// 私有服务，无需鉴权函数

// ================================
// KV 存储操作
// ================================
async function kvEnsureConfigEntry(): Promise<Deno.KvEntry<ProxyConfig>> {
  let entry = await kv.get<ProxyConfig>(CONFIG_KEY);
  if (!entry.value) {
    const defaultConfig: ProxyConfig = {
      defaultModel: 'qwen-3-235b-a22b-instruct-2507',
      currentKeyIndex: 0,
      totalRequests: 0,
      schemaVersion: '2.0'
    };
    await kv.set(CONFIG_KEY, defaultConfig);
    entry = await kv.get<ProxyConfig>(CONFIG_KEY);
  }
  if (!entry.value) {
    throw new Error("KV 配置初始化失败");
  }
  return entry as Deno.KvEntry<ProxyConfig>;
}

async function kvGetConfig(): Promise<ProxyConfig> {
  const entry = await kvEnsureConfigEntry();
  return entry.value;
}

async function kvUpdateConfig(updater: (config: ProxyConfig) => ProxyConfig | Promise<ProxyConfig>): Promise<ProxyConfig> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await kvEnsureConfigEntry();
    const nextConfig = await updater(entry.value);
    const result = await kv.atomic().check(entry).set(CONFIG_KEY, nextConfig).commit();
    if (result.ok) {
      return nextConfig;
    }
  }
  throw new Error("配置更新失败：达到最大重试次数");
}

async function kvGetAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const iter = kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ApiKey);
  }
  return keys;
}

async function kvAddKey(key: string): Promise<{ success: boolean; id?: string; error?: string }> {
  const allKeys = await kvGetAllKeys();

  // 检查密钥是否已存在
  const existingKey = allKeys.find(k => k.key === key);
  if (existingKey) {
    return { success: false, error: "密钥已存在" };
  }

  const id = generateId();
  const newKey: ApiKey = {
    id,
    key,
    useCount: 0,
    status: 'active',
    createdAt: Date.now(),
  };

  await kv.set([...API_KEY_PREFIX, id], newKey);

  console.log(`✅ 添加密钥成功，当前密钥数量: ${(await kvGetAllKeys()).length}`);

  return { success: true, id };
}

async function kvDeleteKey(id: string): Promise<{ success: boolean; error?: string }> {
  const key = [...API_KEY_PREFIX, id];
  const result = await kv.get(key);
  if (!result.value) {
    return { success: false, error: "密钥不存在" };
  }

  await kv.delete(key);
  return { success: true };
}

async function kvUpdateKey(id: string, updates: Partial<ApiKey>): Promise<void> {
  const key = [...API_KEY_PREFIX, id];
  const result = await kv.get<ApiKey>(key);
  if (result.value) {
    const updated = { ...result.value, ...updates };
    await kv.set(key, updated);
  }
}

async function kvGetNextApiKey(): Promise<{ key: string; id: string } | null> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const [configEntry, keys] = await Promise.all([kvEnsureConfigEntry(), kvGetAllKeys()]);
    const activeKeys = keys.filter(k => k.status === 'active');

    if (activeKeys.length === 0) {
      return null;
    }

    const activeIndex = configEntry.value.currentKeyIndex % activeKeys.length;
    const selectedKey = activeKeys[activeIndex];
    const selectedEntry = await kv.get<ApiKey>([...API_KEY_PREFIX, selectedKey.id]);
    if (!selectedEntry.value || selectedEntry.value.status !== 'active') {
      continue;
    }

    const newIndex = (activeIndex + 1) % activeKeys.length;
    const updatedConfig: ProxyConfig = {
      ...configEntry.value,
      currentKeyIndex: newIndex,
      totalRequests: configEntry.value.totalRequests + 1
    };
    const updatedKey: ApiKey = {
      ...selectedEntry.value,
      useCount: selectedEntry.value.useCount + 1,
      lastUsed: Date.now()
    };

    const result = await kv.atomic()
      .check(configEntry)
      .check(selectedEntry)
      .set(CONFIG_KEY, updatedConfig)
      .set([...API_KEY_PREFIX, selectedKey.id], updatedKey)
      .commit();

    if (result.ok) {
      return { key: selectedEntry.value.key, id: selectedEntry.value.id };
    }
  }

  throw new Error("获取可用密钥失败：达到最大重试次数");
}

// ================================
// API 密钥管理
// ================================
async function testKey(id: string): Promise<{ success: boolean; status: string; error?: string }> {
  const allKeys = await kvGetAllKeys();
  const apiKey = allKeys.find(k => k.id === id);

  if (!apiKey) {
    return { success: false, status: 'invalid', error: "密钥不存在" };
  }

  const config = await kvGetConfig();

  try {
    const response = await fetch(CEREBRAS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.key}`,
      },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      }),
    });

    if (response.ok) {
      await kvUpdateKey(id, { status: 'active' });
      return { success: true, status: 'active' };
    } else {
      await kvUpdateKey(id, { status: 'inactive' });
      return { success: false, status: 'inactive', error: `HTTP ${response.status}` };
    }
  } catch (error) {
    await kvUpdateKey(id, { status: 'invalid' });
    return { success: false, status: 'invalid', error: getErrorMessage(error) };
  }
}

// ================================
// HTTP 处理函数
// ================================
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // 处理 OPTIONS 请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // API 路由（私有服务，无需鉴权）
  if (path.startsWith('/api/')) {

    // GET /api/keys - 获取密钥列表
    if (req.method === 'GET' && path === '/api/keys') {
      const keys = await kvGetAllKeys();
      // 隐藏密钥内容，只显示掩码
      const maskedKeys = keys.map(k => ({
        ...k,
        key: maskApiKey(k.key),
      }));
      return new Response(JSON.stringify({ keys: maskedKeys }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /api/keys - 添加密钥
    if (req.method === 'POST' && path === '/api/keys') {
      try {
        const { key } = await req.json();
        if (!key) {
          return new Response(JSON.stringify({ error: "密钥不能为空" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        const result = await kvAddKey(key);
        return new Response(JSON.stringify(result), {
          status: result.success ? 201 : 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: getErrorMessage(error) }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // POST /api/keys/batch - 批量导入
    if (req.method === 'POST' && path === '/api/keys/batch') {
      try {
        let input: string;

        // 尝试解析 JSON 格式
        const contentType = req.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
          try {
            const body = await req.json();
            if (body && typeof body === 'object' && body.input) {
              input = body.input;
            } else if (typeof body === 'string') {
              // 如果直接是字符串，也支持
              input = body;
            } else {
              return new Response(JSON.stringify({ error: "输入格式错误：请提供包含密钥的文本或 JSON 格式 { \"input\": \"密钥列表\" }" }), {
                status: 400,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
              });
            }
          } catch (jsonError) {
            // JSON 解析失败，尝试纯文本
            const text = await req.text();
            if (text.trim()) {
              input = text;
            } else {
              return new Response(JSON.stringify({ error: "请求体不能为空" }), {
                status: 400,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
              });
            }
          }
        } else {
          // 非 JSON 请求，直接读取文本
          input = await req.text();
        }

        if (!input || !input.trim()) {
          return new Response(JSON.stringify({ error: "输入不能为空" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
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
            results.success.push(maskApiKey(key));
          } else {
            results.failed.push({ key: maskApiKey(key), error: result.error || "未知错误" });
          }
        }

        return new Response(JSON.stringify({
          summary: {
            total: keys.length,
            success: results.success.length,
            failed: results.failed.length,
          },
          results,
        }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("批量导入错误:", error);
        return new Response(JSON.stringify({ error: `批量导入失败: ${getErrorMessage(error)}` }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // DELETE /api/keys/:id - 删除密钥
    if (req.method === 'DELETE' && path.startsWith('/api/keys/')) {
      const id = path.split('/').pop()!;
      const result = await kvDeleteKey(id);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /api/keys/:id/test - 测试密钥
    if (req.method === 'POST' && path.startsWith('/api/keys/') && path.endsWith('/test')) {
      const id = path.split('/')[3];
      const result = await testKey(id);
      return new Response(JSON.stringify(result), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GET /api/stats - 获取统计信息
    if (req.method === 'GET' && path === '/api/stats') {
      const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
      const stats = {
        totalKeys: keys.length,
        activeKeys: keys.filter(k => k.status === 'active').length,
        totalRequests: config.totalRequests,
        keyUsage: keys.map(k => ({
          id: k.id,
          maskedKey: maskApiKey(k.key),
          useCount: k.useCount,
          status: k.status,
        })),
      };
      return new Response(JSON.stringify(stats), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GET /api/config - 获取配置
    if (req.method === 'GET' && path === '/api/config') {
      const config = await kvGetConfig();
      return new Response(JSON.stringify(config), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // PUT /api/config/default-model - 更新默认模型
    if (req.method === 'PUT' && path === '/api/config/default-model') {
      try {
        const { model } = await req.json();
        if (!model) {
          return new Response(JSON.stringify({ error: "模型名称不能为空" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        await kvUpdateConfig(config => ({ ...config, defaultModel: model }));

        return new Response(JSON.stringify({ success: true, defaultModel: model }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: getErrorMessage(error) }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "API 路由未找到" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // GET /v1/models - OpenAI 兼容的模型列表接口
  if (req.method === 'GET' && path === '/v1/models') {
    const config = await kvGetConfig();
    const response = {
      object: "list",
      data: [
        {
          id: config.defaultModel,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cerebras",
        }
      ]
    };

    return new Response(JSON.stringify(response), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      },
    });
  }

  // POST /v1/chat/completions - 代理转发
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    if (!isProxyAuthorized(req)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    try {
      const requestBody = await req.json();

      // 模型映射
      const config = await kvGetConfig();
      const originalModel = requestBody.model;
      requestBody.model = config.defaultModel;

      console.log(`[代理] 收到请求，模型映射: ${originalModel} -> ${config.defaultModel}`);

      const apiKeyData = await kvGetNextApiKey();
      if (!apiKeyData) {
        console.error(`[代理] 没有可用的 API 密钥`);
        return new Response(JSON.stringify({
          error: "没有可用的 API 密钥"
        }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      console.log(`[代理] 使用密钥: ${apiKeyData.id.substring(0, 8)}...`);

      const apiResponse = await fetch(CEREBRAS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKeyData.key}`,
        },
        body: JSON.stringify(requestBody),
      });

      console.log(`[代理] Cerebras 响应状态: ${apiResponse.status}`);

      const responseHeaders = new Headers(apiResponse.headers);
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });

      return new Response(apiResponse.body, {
        status: apiResponse.status,
        statusText: apiResponse.statusText,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error(`[代理] 错误:`, error);
      return new Response(JSON.stringify({ error: getErrorMessage(error) }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  }

  // 主页
  if (path === '/' && req.method === 'GET') {
    const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
    const stats = {
      totalKeys: keys.length,
      activeKeys: keys.filter(k => k.status === 'active').length,
      totalRequests: config.totalRequests,
      authEnabled: Boolean(AUTH_PASSWORD),
    };

    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cerebras 密钥管理系统</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
          }
          h1 {
            color: #333;
            font-size: 28px;
          }
          .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
          }
          .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
          }
          .stat-value {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 5px;
          }
          .stat-label {
            font-size: 14px;
            opacity: 0.9;
          }
          .admin-panel {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
          }
          .admin-toggle {
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
          }
          .admin-toggle:hover {
            background: #5568d3;
          }
          .admin-content {
            display: none;
            margin-top: 20px;
          }
          .admin-content.active {
            display: block;
          }
          .form-group {
            margin-bottom: 15px;
          }
          .form-group label {
            display: block;
            margin-bottom: 5px;
            color: #333;
            font-weight: 500;
          }
          .form-control {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
          }
          .form-control:focus {
            outline: none;
            border-color: #667eea;
          }
          textarea.form-control {
            resize: vertical;
            min-height: 100px;
          }
          .btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s;
          }
          .btn:hover {
            background: #5568d3;
          }
          .btn-danger {
            background: #dc3545;
          }
          .btn-danger:hover {
            background: #c82333;
          }
          .btn-success {
            background: #28a745;
          }
          .btn-success:hover {
            background: #218838;
          }
          .keys-list {
            margin-top: 20px;
          }
          .key-item {
            background: white;
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .key-info {
            flex: 1;
          }
          .key-masked {
            font-family: monospace;
            color: #333;
            margin-bottom: 5px;
          }
          .key-stats {
            font-size: 12px;
            color: #666;
          }
          .status-badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            margin-left: 8px;
          }
          .status-active { background: #d4edda; color: #155724; }
          .status-inactive { background: #fff3cd; color: #856404; }
          .status-invalid { background: #f8d7da; color: #721c24; }
          .key-actions {
            display: flex;
            gap: 10px;
          }
          .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            background: white;
            border-radius: 8px;
            padding: 15px 20px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            display: none;
            z-index: 1000;
          }
          .notification.show {
            display: block;
            animation: slideIn 0.3s ease;
          }
          @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          .notification.success { border-left: 4px solid #28a745; }
          .notification.error { border-left: 4px solid #dc3545; }
          .model-config {
            background: #e7f3ff;
            border: 1px solid #b3d9ff;
            border-radius: 6px;
            padding: 15px;
            margin-top: 20px;
          }
          .model-config h3 {
            margin-top: 0;
            color: #0066cc;
          }
          .model-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
          }
          .model-tag {
            background: #667eea;
            color: white;
            padding: 5px 12px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
          }
          .model-tag:hover {
            background: #5568d3;
            transform: scale(1.05);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔑 Cerebras 密钥管理系统</h1>
            <button class="admin-toggle" onclick="toggleAdminPanel()">管理面板</button>
          </div>

          <div class="stats">
            <div class="stat-card">
              <div class="stat-value">${stats.totalKeys}</div>
              <div class="stat-label">总密钥数</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.activeKeys}</div>
              <div class="stat-label">活跃密钥</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.totalRequests}</div>
              <div class="stat-label">总请求数</div>
            </div>
            <div class="stat-card" style="background: linear-gradient(135deg, #34d399 0%, #059669 100%);">
              <div class="stat-value">${stats.authEnabled ? '已启用' : '未启用'}</div>
              <div class="stat-label">代理鉴权</div>
            </div>
          </div>

          <div class="admin-panel">
            <button class="admin-toggle" onclick="toggleAdminPanel()">🔧 密钥管理</button>
            <div id="adminContent" class="admin-content active">
              <div class="form-group">
                <label>🔑 单个密钥添加</label>
                <input type="text" id="singleKey" class="form-control" placeholder="输入 API 密钥">
                <button class="btn" onclick="addSingleKey()" style="margin-top: 10px;">添加密钥</button>
              </div>

              <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">

              <div class="form-group">
                <label>📦 批量导入密钥</label>
                <textarea id="batchKeys" class="form-control" placeholder="支持换行、逗号或空格分隔"></textarea>
                <button class="btn" onclick="addBatchKeys()" style="margin-top: 10px;">批量导入</button>
              </div>

              <div class="model-config">
                <h3>⚙️ 模型配置</h3>
                <p>当前默认模型：<strong id="currentModel">${config.defaultModel}</strong></p>
                <div class="form-group" style="margin-top: 15px;">
                  <label>更改默认模型</label>
                  <input type="text" id="newModel" class="form-control" placeholder="输入新的模型名称" value="${config.defaultModel}">
                  <button class="btn" onclick="updateDefaultModel()" style="margin-top: 10px;">更新模型</button>
                </div>
                <p style="margin-top: 15px; font-size: 12px; color: #666;">
                  💡 支持自动映射：输入任意模型名（如 gpt-4、claude）都会自动映射到默认模型
                </p>
              </div>

              <div class="keys-list" id="keysList">
                <h3 style="margin-bottom: 15px;">密钥列表</h3>
                <div id="keysContainer"></div>
              </div>
            </div>
          </div>

          <div class="notification" id="notification"></div>
        </div>

        <script>
          let adminVisible = true;

          function toggleAdminPanel() {
            adminVisible = !adminVisible;
            const content = document.getElementById('adminContent');
            content.classList.toggle('active', adminVisible);
            if (adminVisible) {
              loadKeys();
              loadConfig();
            }
          }

          function showNotification(message, type = 'success') {
            const notif = document.getElementById('notification');
            notif.textContent = message;
            notif.className = 'notification show ' + type;
            setTimeout(() => {
              notif.classList.remove('show');
            }, 3000);
          }

          async function addSingleKey() {
            const key = document.getElementById('singleKey').value.trim();
            if (!key) {
              showNotification('请输入密钥', 'error');
              return;
            }

            try {
              const response = await fetch('/api/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
              });
              const data = await response.json();
              if (data.success) {
                showNotification('密钥添加成功');
                document.getElementById('singleKey').value = '';
                // 延迟刷新确保数据已保存
                setTimeout(() => loadKeys(), 500);
              } else {
                showNotification(data.error || '添加失败', 'error');
              }
            } catch (error) {
              showNotification('请求失败: ' + error.message, 'error');
            }
          }

          async function addBatchKeys() {
            const input = document.getElementById('batchKeys').value.trim();
            if (!input) {
              showNotification('请输入密钥', 'error');
              return;
            }

            try {
              const response = await fetch('/api/keys/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input }),
              });
              const data = await response.json();
              if (data.summary) {
                showNotification(\`批量导入完成: 成功 \${data.summary.success} 个，失败 \${data.summary.failed} 个\`);
                document.getElementById('batchKeys').value = '';
                // 延迟刷新确保数据已保存
                setTimeout(() => loadKeys(), 500);
              } else {
                showNotification(data.error || '导入失败', 'error');
              }
            } catch (error) {
              showNotification('请求失败: ' + error.message, 'error');
            }
          }

          async function loadKeys() {
            try {
              const response = await fetch('/api/keys');
              const data = await response.json();
              const container = document.getElementById('keysContainer');
              container.innerHTML = '';

              if (data.keys && data.keys.length > 0) {
                data.keys.forEach(keyData => {
                  const item = document.createElement('div');
                  item.className = 'key-item';
                  item.innerHTML = \`
                    <div class="key-info">
                      <div class="key-masked">\${keyData.key}</div>
                      <div class="key-stats">
                        使用次数: \${keyData.useCount}
                        <span class="status-badge status-\${keyData.status}">\${keyData.status}</span>
                      </div>
                    </div>
                    <div class="key-actions">
                      <button class="btn btn-success" onclick="testKey('\${keyData.id}')">测试</button>
                      <button class="btn btn-danger" onclick="deleteKey('\${keyData.id}')">删除</button>
                    </div>
                  \`;
                  container.appendChild(item);
                });
              } else {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">暂无密钥</p>';
              }
            } catch (error) {
              showNotification('加载密钥失败: ' + error.message, 'error');
            }
          }

          async function loadConfig() {
            try {
              const response = await fetch('/api/config');
              const config = await response.json();
              document.getElementById('currentModel').textContent = config.defaultModel;
              document.getElementById('newModel').value = config.defaultModel;
            } catch (error) {
              showNotification('加载配置失败: ' + error.message, 'error');
            }
          }

          async function updateDefaultModel() {
            const newModel = document.getElementById('newModel').value.trim();
            if (!newModel) {
              showNotification('请输入模型名称', 'error');
              return;
            }

            try {
              const response = await fetch('/api/config/default-model', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: newModel }),
              });
              const data = await response.json();
              if (data.success) {
                showNotification(\`默认模型已更新为: \${data.defaultModel}\`);
                loadConfig();
              } else {
                showNotification(data.error || '更新失败', 'error');
              }
            } catch (error) {
              showNotification('请求失败: ' + error.message, 'error');
            }
          }

          async function deleteKey(id) {
            if (!confirm('确定要删除这个密钥吗？')) return;

            try {
              const response = await fetch(\`/api/keys/\${id}\`, { method: 'DELETE' });
              const data = await response.json();
              if (data.success) {
                showNotification('密钥删除成功');
                loadKeys();
              } else {
                showNotification(data.error || '删除失败', 'error');
              }
            } catch (error) {
              showNotification('请求失败: ' + error.message, 'error');
            }
          }

          async function testKey(id) {
            try {
              const response = await fetch(\`/api/keys/\${id}/test\`, { method: 'POST' });
              const data = await response.json();
              if (data.success) {
                showNotification('密钥测试成功: ' + data.status);
              } else {
                showNotification('密钥测试失败: ' + (data.error || data.status), 'error');
              }
              loadKeys();
            } catch (error) {
              showNotification('请求失败: ' + error.message, 'error');
            }
          }

          // 初始加载
          loadKeys();
          loadConfig();
        </script>
      </body>
      </html>
    `, {
      headers: { "Content-Type": "text/html" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

// ================================
// 启动服务器
// ================================
console.log(`🚀 Cerebras 密钥管理系统启动 (KV 持久化版 v2.0)`);
console.log(`- 管理面板: 主页`);
console.log(`- API 代理: /v1/chat/completions`);
console.log(`- 默认模型接口: /v1/models`);
console.log(`- 代理鉴权: ${AUTH_PASSWORD ? '启用' : '未启用'}`);
console.log(`- 模式: 私有代理服务`);
console.log(`- 请求间隔: ${RATE_LIMIT_MS}ms`);
console.log(`- 存储方式: Deno KV 持久化存储`);

// Usage example
if (import.meta.main) {
  serve(handler);
}
