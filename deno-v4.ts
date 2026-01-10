// deno-v4.ts - Cerebras API 代理与密钥管理系统（KV 持久化版 v4）
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// ================================
// 配置常量
// ================================
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const AUTH_PASSWORD = (Deno.env.get("AUTH_PASSWORD")?.trim() || '') || null;
const KV_PREFIX = "cerebras-proxy"; // KV 键前缀
const CONFIG_KEY = [KV_PREFIX, "meta", "config"] as const;
const API_KEY_PREFIX = [KV_PREFIX, "keys", "api"] as const;
const KV_ATOMIC_MAX_RETRIES = 10;
const DEFAULT_KV_FLUSH_INTERVAL_MS = 15000;
const KV_FLUSH_INTERVAL_MS = (() => {
  const raw = (Deno.env.get("KV_FLUSH_INTERVAL_MS") ?? "").trim();
  if (!raw) return DEFAULT_KV_FLUSH_INTERVAL_MS;
  const ms = Number.parseInt(raw, 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_KV_FLUSH_INTERVAL_MS;
})();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE, PUT',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
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
  modelPool: string[];  // v2.1: 模型池（替代 defaultModel）
  currentModelIndex: number;  // 模型轮询游标
  currentKeyIndex: number;
  totalRequests: number;
  schemaVersion: string;
}

// 默认模型池（首次初始化或迁移时预填）
const DEFAULT_MODEL_POOL = [
  'gpt-oss-120b',
  'qwen-3-235b-a22b-instruct-2507',
  'zai-glm-4.6',
  'zai-glm-4.7',
];
const FALLBACK_MODEL = 'qwen-3-235b-a22b-instruct-2507';
const EXTERNAL_MODEL_ID = 'cerebras-translator';

// ================================
// 运行时缓存（Ultra：热路径不触碰 KV）
// ================================
let cachedConfig: ProxyConfig | null = null;
let cachedKeysById = new Map<string, ApiKey>();
let cachedActiveKeyIds: string[] = [];
let cachedCursor = 0;
const keyCooldownUntil = new Map<string, number>();
const dirtyKeyIds = new Set<string>();
let dirtyConfig = false;
let flushInProgress = false;

// 模型池缓存
let cachedModelPool: string[] = [];
let modelCursor = 0;

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
function rebuildActiveKeyIds(): void {
  const keys = Array.from(cachedKeysById.values());
  keys.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  cachedActiveKeyIds = keys.filter(k => k.status === 'active').map(k => k.id);
  if (cachedActiveKeyIds.length === 0) {
    cachedCursor = 0;
    return;
  }
  cachedCursor = cachedCursor % cachedActiveKeyIds.length;
}

function getCachedConfigOrThrow(): ProxyConfig {
  if (!cachedConfig) throw new Error("代理未初始化：配置未加载");
  return cachedConfig;
}

function getNextApiKeyFast(now: number): { key: string; id: string } | null {
  if (cachedActiveKeyIds.length === 0) return null;

  for (let offset = 0; offset < cachedActiveKeyIds.length; offset++) {
    const idx = (cachedCursor + offset) % cachedActiveKeyIds.length;
    const id = cachedActiveKeyIds[idx];
    const cooldownUntil = keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;

    const keyEntry = cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== 'active') continue;

    cachedCursor = (idx + 1) % cachedActiveKeyIds.length;

    keyEntry.useCount += 1;
    keyEntry.lastUsed = now;
    dirtyKeyIds.add(id);

    if (cachedConfig) {
      cachedConfig.totalRequests += 1;
      dirtyConfig = true;
    }

    return { key: keyEntry.key, id };
  }

  return null;
}

function markKeyCooldownFrom429(id: string, response: Response): void {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number.parseInt(retryAfter, 10) * 1000 : 2000;
  keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}

function markKeyInvalid(id: string): void {
  const keyEntry = cachedKeysById.get(id);
  if (!keyEntry) return;
  if (keyEntry.status === 'invalid') return;
  keyEntry.status = 'invalid';
  dirtyKeyIds.add(id);
  keyCooldownUntil.delete(id);
  rebuildActiveKeyIds();
}

// 模型池轮询：Round-Robin 取下一个模型
function getNextModelFast(): string {
  if (cachedModelPool.length === 0) {
    return FALLBACK_MODEL;
  }
  const idx = modelCursor % cachedModelPool.length;
  const model = cachedModelPool[idx];
  modelCursor = (idx + 1) % cachedModelPool.length;

  if (cachedConfig) {
    cachedConfig.currentModelIndex = modelCursor;
    dirtyConfig = true;
  }

  return model;
}

// 刷新模型池缓存
function rebuildModelPoolCache(): void {
  if (cachedConfig && cachedConfig.modelPool && cachedConfig.modelPool.length > 0) {
    cachedModelPool = [...cachedConfig.modelPool];
    modelCursor = (cachedConfig.currentModelIndex ?? 0) % cachedModelPool.length;
  } else {
    cachedModelPool = [...DEFAULT_MODEL_POOL];
    modelCursor = 0;
  }
}

async function flushDirtyToKv(): Promise<void> {
  if (flushInProgress) return;
  if (!dirtyConfig && dirtyKeyIds.size === 0) return;
  if (!cachedConfig) return;

  flushInProgress = true;
  const keyIds = Array.from(dirtyKeyIds);
  dirtyKeyIds.clear();
  const flushConfig = dirtyConfig;
  dirtyConfig = false;

  try {
    const tasks: Promise<unknown>[] = [];
    for (const id of keyIds) {
      const keyEntry = cachedKeysById.get(id);
      if (!keyEntry) continue;
      tasks.push(kv.set([...API_KEY_PREFIX, id], keyEntry));
    }
    if (flushConfig) {
      tasks.push(kv.set(CONFIG_KEY, cachedConfig));
    }
    await Promise.all(tasks);
  } catch (error) {
    for (const id of keyIds) dirtyKeyIds.add(id);
    dirtyConfig = dirtyConfig || flushConfig;
    console.error(`[KV] flush failed:`, error);
  } finally {
    flushInProgress = false;
  }
}

async function bootstrapCache(): Promise<void> {
  cachedConfig = await kvGetConfig();
  const keys = await kvGetAllKeys();
  cachedKeysById = new Map(keys.map(k => [k.id, k]));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();
}

// ================================
// KV 存储操作
// ================================
// deno-lint-ignore no-explicit-any
interface LegacyProxyConfig {
  defaultModel?: string;
  modelPool?: string[];
  currentModelIndex?: number;
  currentKeyIndex: number;
  totalRequests: number;
  schemaVersion: string;
}

async function kvEnsureConfigEntry(): Promise<Deno.KvEntry<ProxyConfig>> {
  let entry = await kv.get<LegacyProxyConfig>(CONFIG_KEY);

  // 首次初始化：直接创建 v2.1 配置
  if (!entry.value) {
    const defaultConfig: ProxyConfig = {
      modelPool: [...DEFAULT_MODEL_POOL],
      currentModelIndex: 0,
      currentKeyIndex: 0,
      totalRequests: 0,
      schemaVersion: '2.1'
    };
    await kv.set(CONFIG_KEY, defaultConfig);
    entry = await kv.get<LegacyProxyConfig>(CONFIG_KEY);
  }

  // 迁移逻辑：从 v2.0 升级到 v2.1
  if (entry.value && (entry.value.schemaVersion === '2.0' || !entry.value.modelPool)) {
    console.log(`[KV] 检测到旧版 schema (${entry.value.schemaVersion})，执行迁移...`);

    // 收集模型池：旧 defaultModel + 默认模型池，去重
    const models = new Set<string>(DEFAULT_MODEL_POOL);
    if (entry.value.defaultModel) {
      models.add(entry.value.defaultModel);
    }

    const migratedConfig: ProxyConfig = {
      modelPool: Array.from(models),
      currentModelIndex: 0,
      currentKeyIndex: entry.value.currentKeyIndex ?? 0,
      totalRequests: entry.value.totalRequests ?? 0,
      schemaVersion: '2.1'
    };

    await kv.set(CONFIG_KEY, migratedConfig);
    entry = await kv.get<LegacyProxyConfig>(CONFIG_KEY);
    console.log(`[KV] 迁移完成，模型池: ${migratedConfig.modelPool.join(', ')}`);
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
      cachedConfig = nextConfig;
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
  const allKeys = Array.from(cachedKeysById.values());

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
  cachedKeysById.set(id, newKey);
  rebuildActiveKeyIds();

  console.log(`✅ 添加密钥成功，当前密钥数量: ${cachedKeysById.size}`);

  return { success: true, id };
}

async function kvDeleteKey(id: string): Promise<{ success: boolean; error?: string }> {
  const key = [...API_KEY_PREFIX, id];
  const result = await kv.get(key);
  if (!result.value) {
    return { success: false, error: "密钥不存在" };
  }

  await kv.delete(key);
  cachedKeysById.delete(id);
  keyCooldownUntil.delete(id);
  dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
  return { success: true };
}

async function kvUpdateKey(id: string, updates: Partial<ApiKey>): Promise<void> {
  const key = [...API_KEY_PREFIX, id];
  const existing = cachedKeysById.get(id) ?? (await kv.get<ApiKey>(key)).value;
  if (!existing) return;
  const updated = { ...existing, ...updates };
  cachedKeysById.set(id, updated);
  rebuildActiveKeyIds();
  await kv.set(key, updated);
}

// ================================
// API 密钥管理
// ================================
async function testKey(id: string): Promise<{ success: boolean; status: string; error?: string }> {
  const apiKey = cachedKeysById.get(id);

  if (!apiKey) {
    return { success: false, status: 'invalid', error: "密钥不存在" };
  }

  // 使用模型池第一个模型测试（或回退模型）
  const testModel = cachedModelPool.length > 0 ? cachedModelPool[0] : FALLBACK_MODEL;

  try {
    const response = await fetch(CEREBRAS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.key}`,
      },
      body: JSON.stringify({
        model: testModel,
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
        headers: { ...CORS_HEADERS, ...NO_CACHE_HEADERS, "Content-Type": "application/json" },
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
        headers: { ...CORS_HEADERS, ...NO_CACHE_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GET /api/config - 获取配置
    if (req.method === 'GET' && path === '/api/config') {
      const config = await kvGetConfig();
      return new Response(JSON.stringify(config), {
        headers: { ...CORS_HEADERS, ...NO_CACHE_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ================================
    // 模型池管理 API
    // ================================

    // GET /api/models - 获取模型池列表
    if (req.method === 'GET' && path === '/api/models') {
      const config = await kvGetConfig();
      const models = config.modelPool && config.modelPool.length > 0 ? config.modelPool : DEFAULT_MODEL_POOL;
      return new Response(JSON.stringify({ models }), {
        headers: { ...CORS_HEADERS, ...NO_CACHE_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /api/models - 添加单个模型
    if (req.method === 'POST' && path === '/api/models') {
      try {
        const { model } = await req.json();
        if (!model || typeof model !== 'string' || !model.trim()) {
          return new Response(JSON.stringify({ error: "模型名称不能为空" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        const trimmedModel = model.trim();
        if (cachedModelPool.includes(trimmedModel)) {
          return new Response(JSON.stringify({ error: "模型已存在" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        await kvUpdateConfig(config => ({
          ...config,
          modelPool: [...config.modelPool, trimmedModel]
        }));
        rebuildModelPoolCache();

        console.log(`✅ 添加模型成功: ${trimmedModel}，当前模型池: ${cachedModelPool.join(', ')}`);

        return new Response(JSON.stringify({ success: true, model: trimmedModel }), {
          status: 201,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: getErrorMessage(error) }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    // DELETE /api/models/:name - 删除指定模型
    if (req.method === 'DELETE' && path.startsWith('/api/models/')) {
      const encodedName = path.substring('/api/models/'.length);
      const modelName = decodeURIComponent(encodedName);

      if (!cachedModelPool.includes(modelName)) {
        return new Response(JSON.stringify({ error: "模型不存在" }), {
          status: 404,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      await kvUpdateConfig(config => ({
        ...config,
        modelPool: config.modelPool.filter(m => m !== modelName),
        currentModelIndex: 0  // 重置游标避免越界
      }));
      rebuildModelPoolCache();

      console.log(`🗑️ 删除模型: ${modelName}，当前模型池: ${cachedModelPool.join(', ')}`);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // POST /api/models/:name/test - 测试模型可用性
    if (req.method === 'POST' && path.startsWith('/api/models/') && path.endsWith('/test')) {
      const parts = path.split('/');
      const encodedName = parts[3];
      const modelName = decodeURIComponent(encodedName);

      // 需要至少一个可用密钥来测试
      const activeKey = Array.from(cachedKeysById.values()).find(k => k.status === 'active');
      if (!activeKey) {
        return new Response(JSON.stringify({ success: false, error: "没有可用的 API 密钥来测试" }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      try {
        const response = await fetch(CEREBRAS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeKey.key}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 1,
          }),
        });

        if (response.ok) {
          return new Response(JSON.stringify({ success: true, status: 'available' }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } else {
          return new Response(JSON.stringify({ success: false, status: 'unavailable', error: `HTTP ${response.status}` }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ success: false, status: 'error', error: getErrorMessage(error) }), {
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
    const now = Math.floor(Date.now() / 1000);
    const response = {
      object: "list",
      data: [
        {
          id: EXTERNAL_MODEL_ID,
          object: "model",
          created: now,
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

      // 模型轮询
      const originalModel = requestBody.model;
      const targetModel = getNextModelFast();
      requestBody.model = targetModel;

      console.log(`[代理] 收到请求，模型轮询: ${originalModel} -> ${targetModel}`);

      const apiKeyData = getNextApiKeyFast(Date.now());
      if (!apiKeyData) {
        const now = Date.now();
        const activeIds = cachedActiveKeyIds;
        const cooldowns = activeIds.map(id => keyCooldownUntil.get(id) ?? 0).filter(ms => ms > now);
        const minCooldownUntil = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
        const retryAfterSeconds = minCooldownUntil > now ? Math.ceil((minCooldownUntil - now) / 1000) : 0;

        console.error(`[代理] 没有可用的 API 密钥（无 active 或全部 cooldown）`);
        return new Response(JSON.stringify({
          error: "没有可用的 API 密钥"
        }), {
          status: activeIds.length > 0 ? 429 : 500,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            ...(retryAfterSeconds > 0 ? { "Retry-After": String(retryAfterSeconds) } : {}),
          },
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
        <title>Cerebras Proxy</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: #0a0e17;
            min-height: 100vh;
            padding: 40px 20px;
            color: #e2e8f0;
          }
          .container {
            max-width: 1100px;
            margin: 0 auto;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 48px;
            padding-bottom: 24px;
            border-bottom: 1px solid rgba(56, 189, 248, 0.1);
          }
          h1 {
            font-size: 24px;
            font-weight: 500;
            letter-spacing: -0.02em;
            color: #f1f5f9;
          }
          h1 span { color: #38bdf8; }
          .stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 48px;
          }
          @media (max-width: 768px) {
            .stats { grid-template-columns: repeat(2, 1fr); }
          }
          .stat-card {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(56, 189, 248, 0.08);
            padding: 24px;
            border-radius: 8px;
            text-align: center;
            transition: border-color 0.2s;
          }
          .stat-card:hover {
            border-color: rgba(56, 189, 248, 0.2);
          }
          .stat-value {
            font-size: 36px;
            font-weight: 600;
            color: #38bdf8;
            margin-bottom: 8px;
            letter-spacing: -0.02em;
          }
          .stat-card:nth-child(4) .stat-value { color: #22d3d8; }
          .stat-label {
            font-size: 13px;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .section {
            background: rgba(15, 23, 42, 0.4);
            border: 1px solid rgba(56, 189, 248, 0.06);
            border-radius: 8px;
            padding: 32px;
            margin-bottom: 24px;
          }
          .section-title {
            font-size: 14px;
            font-weight: 500;
            color: #94a3b8;
            margin-bottom: 20px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }
          .form-group {
            margin-bottom: 20px;
          }
          .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #94a3b8;
            font-size: 13px;
            font-weight: 500;
          }
          .form-control {
            width: 100%;
            padding: 12px 16px;
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid rgba(56, 189, 248, 0.1);
            border-radius: 6px;
            font-size: 14px;
            color: #e2e8f0;
            font-family: 'Inter', monospace;
            transition: border-color 0.2s, box-shadow 0.2s;
          }
          .form-control::placeholder { color: #475569; }
          .form-control:focus {
            outline: none;
            border-color: #38bdf8;
            box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1);
          }
          textarea.form-control {
            resize: vertical;
            min-height: 100px;
          }
          .btn {
            background: transparent;
            color: #38bdf8;
            border: 1px solid rgba(56, 189, 248, 0.3);
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            font-family: 'Inter', sans-serif;
          }
          .btn:hover {
            background: rgba(56, 189, 248, 0.1);
            border-color: #38bdf8;
          }
          .btn-danger {
            color: #f87171;
            border-color: rgba(248, 113, 113, 0.3);
          }
          .btn-danger:hover {
            background: rgba(248, 113, 113, 0.1);
            border-color: #f87171;
          }
          .btn-success {
            color: #34d399;
            border-color: rgba(52, 211, 153, 0.3);
          }
          .btn-success:hover {
            background: rgba(52, 211, 153, 0.1);
            border-color: #34d399;
          }
          .divider {
            height: 1px;
            background: rgba(56, 189, 248, 0.08);
            margin: 28px 0;
          }
          .list-item {
            background: rgba(15, 23, 42, 0.5);
            border: 1px solid rgba(56, 189, 248, 0.06);
            border-radius: 6px;
            padding: 16px 20px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: border-color 0.2s;
          }
          .list-item:hover {
            border-color: rgba(56, 189, 248, 0.15);
          }
          .item-info { flex: 1; }
          .item-primary {
            font-family: 'SF Mono', 'Fira Code', monospace;
            color: #e2e8f0;
            font-size: 13px;
            margin-bottom: 4px;
          }
          .item-secondary {
            font-size: 12px;
            color: #64748b;
          }
          .status-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            margin-left: 12px;
            text-transform: uppercase;
            letter-spacing: 0.03em;
          }
          .status-active { background: rgba(52, 211, 153, 0.15); color: #34d399; }
          .status-inactive { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
          .status-invalid { background: rgba(248, 113, 113, 0.15); color: #f87171; }
          .item-actions {
            display: flex;
            gap: 8px;
          }
          .notification {
            position: fixed;
            top: 24px;
            right: 24px;
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid rgba(56, 189, 248, 0.2);
            padding: 16px 24px;
            display: none;
            z-index: 1000;
            backdrop-filter: blur(8px);
            font-size: 14px;
          }
          .notification.show {
            display: block;
            animation: slideIn 0.3s ease;
          }
          @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          .notification.success { color: #34d399; }
          .notification.error { color: #f87171; }
          .hint {
            font-size: 12px;
            color: #475569;
            margin-top: 16px;
          }
          .empty-state {
            text-align: center;
            padding: 32px;
            color: #475569;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1><span>Cerebras</span> Proxy</h1>
          </div>

          <div class="stats">
            <div class="stat-card">
              <div class="stat-value">${stats.totalKeys}</div>
              <div class="stat-label">Total Keys</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.activeKeys}</div>
              <div class="stat-label">Active</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.totalRequests}</div>
              <div class="stat-label">Requests</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.authEnabled ? 'ON' : 'OFF'}</div>
              <div class="stat-label">Auth</div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Key Management</div>
            <div class="form-group">
              <label>Add Single Key</label>
              <input type="text" id="singleKey" class="form-control" placeholder="Enter API key">
              <button class="btn" onclick="addSingleKey()" style="margin-top: 12px;">Add Key</button>
            </div>

            <div class="divider"></div>

            <div class="form-group">
              <label>Batch Import</label>
              <textarea id="batchKeys" class="form-control" placeholder="Separate keys by newline, comma, or space"></textarea>
              <button class="btn" onclick="addBatchKeys()" style="margin-top: 12px;">Import</button>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Model Pool</div>
            <p class="hint" style="margin-top: 0; margin-bottom: 16px;">Round-robin rotation across models to distribute TPM load</p>
            <div class="form-group">
              <label>Add Model</label>
              <input type="text" id="newModel" class="form-control" placeholder="e.g. gpt-oss-120b">
              <button class="btn" onclick="addModel()" style="margin-top: 12px;">Add Model</button>
            </div>
            <div class="divider"></div>
            <div id="modelsContainer"></div>
          </div>

          <div class="section">
            <div class="section-title">Keys</div>
            <div id="keysContainer"></div>
          </div>

          <div class="notification" id="notification"></div>
        </div>

        <script>
          function showNotification(message, type = 'success') {
            const notif = document.getElementById('notification');
            notif.textContent = message;
            notif.className = 'notification show ' + type;
            setTimeout(() => notif.classList.remove('show'), 3000);
          }

          async function addSingleKey() {
            const key = document.getElementById('singleKey').value.trim();
            if (!key) { showNotification('Please enter a key', 'error'); return; }
            try {
              const res = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
              const data = await res.json();
              if (data.success) { showNotification('Key added'); document.getElementById('singleKey').value = ''; setTimeout(loadKeys, 300); }
              else showNotification(data.error || 'Failed', 'error');
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          async function addBatchKeys() {
            const input = document.getElementById('batchKeys').value.trim();
            if (!input) { showNotification('Please enter keys', 'error'); return; }
            try {
              const res = await fetch('/api/keys/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
              const data = await res.json();
              if (data.summary) { showNotification(\`Imported: \${data.summary.success} success, \${data.summary.failed} failed\`); document.getElementById('batchKeys').value = ''; setTimeout(loadKeys, 300); }
              else showNotification(data.error || 'Failed', 'error');
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          async function loadKeys() {
            try {
              const res = await fetch('/api/keys');
              const data = await res.json();
              const container = document.getElementById('keysContainer');
              if (data.keys?.length > 0) {
                container.innerHTML = data.keys.map(k => \`
                  <div class="list-item">
                    <div class="item-info">
                      <div class="item-primary">\${k.key}<span class="status-badge status-\${k.status}">\${k.status}</span></div>
                      <div class="item-secondary">Used: \${k.useCount}</div>
                    </div>
                    <div class="item-actions">
                      <button class="btn btn-success" onclick="testKey('\${k.id}')">Test</button>
                      <button class="btn btn-danger" onclick="deleteKey('\${k.id}')">Delete</button>
                    </div>
                  </div>\`).join('');
              } else container.innerHTML = '<div class="empty-state">No keys configured</div>';
            } catch (e) { showNotification('Load failed: ' + e.message, 'error'); }
          }

          async function loadModels() {
            try {
              const res = await fetch('/api/models');
              const data = await res.json();
              const container = document.getElementById('modelsContainer');
              if (data.models?.length > 0) {
                container.innerHTML = data.models.map(m => \`
                  <div class="list-item">
                    <div class="item-info"><div class="item-primary">\${m}</div></div>
                    <div class="item-actions">
                      <button class="btn btn-success" onclick="testModel('\${encodeURIComponent(m)}')">Test</button>
                      <button class="btn btn-danger" onclick="deleteModel('\${encodeURIComponent(m)}')">Delete</button>
                    </div>
                  </div>\`).join('');
              } else container.innerHTML = '<div class="empty-state">No models, using fallback</div>';
            } catch (e) { showNotification('Load failed: ' + e.message, 'error'); }
          }

          async function addModel() {
            const model = document.getElementById('newModel').value.trim();
            if (!model) { showNotification('Please enter model name', 'error'); return; }
            try {
              const res = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
              const data = await res.json();
              if (data.success) { showNotification('Model added: ' + data.model); document.getElementById('newModel').value = ''; loadModels(); }
              else showNotification(data.error || 'Failed', 'error');
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          async function deleteModel(name) {
            if (!confirm('Delete this model?')) return;
            try {
              const res = await fetch('/api/models/' + name, { method: 'DELETE' });
              const data = await res.json();
              if (data.success) { showNotification('Model deleted'); loadModels(); }
              else showNotification(data.error || 'Failed', 'error');
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          async function testModel(name) {
            try {
              const res = await fetch('/api/models/' + name + '/test', { method: 'POST' });
              const data = await res.json();
              showNotification(data.success ? 'Model OK: ' + data.status : 'Model failed: ' + (data.error || data.status), data.success ? 'success' : 'error');
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          async function deleteKey(id) {
            if (!confirm('Delete this key?')) return;
            try {
              const res = await fetch('/api/keys/' + id, { method: 'DELETE' });
              const data = await res.json();
              if (data.success) { showNotification('Key deleted'); loadKeys(); }
              else showNotification(data.error || 'Failed', 'error');
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          async function testKey(id) {
            try {
              const res = await fetch('/api/keys/' + id + '/test', { method: 'POST' });
              const data = await res.json();
              showNotification(data.success ? 'Key OK: ' + data.status : 'Key failed: ' + (data.error || data.status), data.success ? 'success' : 'error');
              loadKeys();
            } catch (e) { showNotification('Error: ' + e.message, 'error'); }
          }

          loadKeys();
          loadModels();
        </script>
      </body>
      </html>
    `, {
      headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/html" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

// ================================
// 启动服务器
// ================================
console.log(`🚀 Cerebras 密钥管理系统启动 (KV 持久化版 v4 - 模型池轮询)`);
console.log(`- 管理面板: 主页`);
console.log(`- API 代理: /v1/chat/completions`);
console.log(`- 模型列表接口: /v1/models`);
console.log(`- 代理鉴权: ${AUTH_PASSWORD ? '启用' : '未启用'}`);
console.log(`- 模式: 私有代理服务`);
console.log(`- 限流: Ultra 默认关闭（直通，宁可 429）`);
console.log(`- 模型轮询: 启用（Round-Robin）`);
console.log(`- 存储方式: Deno KV 持久化存储`);
console.log(`- KV 刷盘间隔: ${KV_FLUSH_INTERVAL_MS}ms`);

// Usage example
if (import.meta.main) {
  await bootstrapCache();
  if (KV_FLUSH_INTERVAL_MS > 0) {
    setInterval(flushDirtyToKv, KV_FLUSH_INTERVAL_MS);
  }
  serve(handler);
}
