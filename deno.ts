// deno.ts - Cerebras API 代理与密钥管理系统
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { hashPassword, verifyPbkdf2Password } from "./src/crypto.ts";
import { generateProxyKey } from "./src/keys.ts";

// ================================
// 配置常量
// ================================
const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_PUBLIC_MODELS_URL = "https://api.cerebras.ai/public/v1/models";
const KV_PREFIX = "cerebras-proxy";
const CONFIG_KEY = [KV_PREFIX, "meta", "config"] as const;
const MODEL_CATALOG_KEY = [KV_PREFIX, "meta", "model_catalog"] as const;
const API_KEY_PREFIX = [KV_PREFIX, "keys", "api"] as const;
const PROXY_KEY_PREFIX = [KV_PREFIX, "keys", "proxy"] as const;
const ADMIN_PASSWORD_KEY = [KV_PREFIX, "meta", "admin_password"] as const;
const ADMIN_TOKEN_PREFIX = [KV_PREFIX, "auth", "token"] as const;
const KV_ATOMIC_MAX_RETRIES = 10;
const MAX_PROXY_KEYS = 5;
const ADMIN_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const UPSTREAM_TEST_TIMEOUT_MS = 12000;
const PROXY_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_KV_FLUSH_INTERVAL_MS = 15000;
const MIN_KV_FLUSH_INTERVAL_MS = 1000;
const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 8000;
const DISABLED_MODEL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const MAX_MODEL_NOT_FOUND_RETRIES = 3;

function normalizeKvFlushIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_KV_FLUSH_INTERVAL_MS;
  return Math.max(MIN_KV_FLUSH_INTERVAL_MS, Math.trunc(ms));
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
};

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
};

function jsonResponse(
  data: unknown,
  options: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers({
    ...CORS_HEADERS,
    ...NO_CACHE_HEADERS,
    "Content-Type": "application/json",
  });

  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers,
  });
}

function jsonError(
  message: string,
  status = 400,
  headers?: HeadersInit,
): Response {
  return jsonResponse({ error: message }, { status, headers });
}

function problemTitle(status: number): string {
  if (status >= 500) return "服务器错误";

  switch (status) {
    case 400:
      return "请求错误";
    case 401:
      return "未授权";
    case 403:
      return "禁止访问";
    case 404:
      return "未找到";
    case 409:
      return "冲突";
    case 429:
      return "请求过多";
    default:
      return "请求失败";
  }
}

function problemResponse(
  detail: string,
  options: {
    status?: number;
    title?: string;
    type?: string;
    instance?: string;
    headers?: HeadersInit;
  } = {},
): Response {
  const status = options.status ?? 400;
  const headers = new Headers({ "Content-Type": "application/problem+json" });

  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return jsonResponse(
    {
      type: options.type ?? "about:blank",
      title: options.title ?? problemTitle(status),
      status,
      detail,
      ...(options.instance ? { instance: options.instance } : {}),
    },
    { status, headers },
  );
}

// ================================
// Deno KV 存储
// ================================
const isDenoDeployment = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
const kv = await (() => {
  if (isDenoDeployment) return Deno.openKv();
  const kvDir = `${import.meta.dirname}/.deno-kv-local`;
  try {
    Deno.mkdirSync(kvDir, { recursive: true });
  } catch { /* exists */ }
  return Deno.openKv(`${kvDir}/kv.sqlite3`);
})();

// ================================
// 类型定义
// ================================
interface ApiKey {
  id: string;
  key: string;
  useCount: number;
  lastUsed?: number;
  status: "active" | "inactive" | "invalid";
  createdAt: number;
}

interface ProxyAuthKey {
  id: string;
  key: string;
  name: string;
  useCount: number;
  lastUsed?: number;
  createdAt: number;
}

interface DisabledModelEntry {
  disabledAt: number;
  reason: string;
}

interface ProxyConfig {
  modelPool: string[];
  currentModelIndex: number;
  totalRequests: number;
  kvFlushIntervalMs?: number;
  disabledModels?: Record<string, DisabledModelEntry>;
  schemaVersion: string;
}

interface ModelCatalog {
  source: "cerebras-public";
  fetchedAt: number;
  models: string[];
}

const DEFAULT_MODEL_POOL = [
  "gpt-oss-120b",
  "qwen-3-235b-a22b-instruct-2507",
  "zai-glm-4.7",
];
const FALLBACK_MODEL = "qwen-3-235b-a22b-instruct-2507";
const EXTERNAL_MODEL_ID = "cerebras-translator";

// ================================
// 运行时缓存
// ================================
let cachedConfig: ProxyConfig | null = null;
let cachedKeysById = new Map<string, ApiKey>();
let cachedActiveKeyIds: string[] = [];
let cachedCursor = 0;
const keyCooldownUntil = new Map<string, number>();
const dirtyKeyIds = new Set<string>();
let dirtyConfig = false;
let flushInProgress = false;

let cachedModelPool: string[] = [];
let modelCursor = 0;

let cachedModelCatalog: ModelCatalog | null = null;
let modelCatalogFetchInFlight: Promise<ModelCatalog> | null = null;

// 代理鉴权密钥缓存
let cachedProxyKeys = new Map<string, ProxyAuthKey>();
const dirtyProxyKeyIds = new Set<string>();

let kvFlushTimerId: number | null = null;
let kvFlushIntervalMsEffective = DEFAULT_KV_FLUSH_INTERVAL_MS;

function resolveKvFlushIntervalMs(config: ProxyConfig | null): number {
  const ms = config?.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS;
  return normalizeKvFlushIntervalMs(ms);
}

function applyKvFlushInterval(config: ProxyConfig | null): void {
  kvFlushIntervalMsEffective = resolveKvFlushIntervalMs(config);

  if (kvFlushTimerId !== null) {
    clearInterval(kvFlushTimerId);
  }
  kvFlushTimerId = setInterval(flushDirtyToKv, kvFlushIntervalMsEffective);
}

// ================================
// 工具函数
// ================================
function generateId(): string {
  return crypto.randomUUID();
}

function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return key.substring(0, 4) + "*".repeat(key.length - 8) +
    key.substring(key.length - 4);
}

function parseBatchInput(input: string): string[] {
  return input
    .split(/[\n,\s]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return (error as { name?: unknown }).name === "AbortError";
  }
  return false;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(0, timeoutMs),
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// 代理 API 鉴权：无密钥则公开，有密钥则验证
function isProxyAuthorized(
  req: Request,
): { authorized: boolean; keyId?: string } {
  if (cachedProxyKeys.size === 0) {
    return { authorized: true };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { authorized: false };
  }

  const token = authHeader.substring(7).trim();
  for (const [id, pk] of cachedProxyKeys) {
    if (pk.key === token) {
      return { authorized: true, keyId: id };
    }
  }

  return { authorized: false };
}

function recordProxyKeyUsage(keyId: string): void {
  const pk = cachedProxyKeys.get(keyId);
  if (!pk) return;
  pk.useCount++;
  pk.lastUsed = Date.now();
  dirtyProxyKeyIds.add(keyId);
}

// 管理面板鉴权
async function getAdminPassword(): Promise<string | null> {
  const entry = await kv.get<string>(ADMIN_PASSWORD_KEY);
  return entry.value;
}

async function setAdminPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await kv.set(ADMIN_PASSWORD_KEY, hash);
}

async function verifyAdminPassword(password: string): Promise<boolean> {
  const stored = await getAdminPassword();
  if (!stored) return false;
  return await verifyPbkdf2Password(password, stored);
}

async function createAdminToken(): Promise<string> {
  const token = crypto.randomUUID();
  const expiry = Date.now() + ADMIN_TOKEN_EXPIRY_MS;
  await kv.set([...ADMIN_TOKEN_PREFIX, token], expiry);
  return token;
}

async function verifyAdminToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const entry = await kv.get<number>([...ADMIN_TOKEN_PREFIX, token]);
  if (!entry.value) return false;
  if (Date.now() > entry.value) {
    await kv.delete([...ADMIN_TOKEN_PREFIX, token]);
    return false;
  }
  return true;
}

async function isAdminAuthorized(req: Request): Promise<boolean> {
  const token = req.headers.get("X-Admin-Token");
  return await verifyAdminToken(token);
}

function rebuildActiveKeyIds(): void {
  const keys = Array.from(cachedKeysById.values());
  keys.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  cachedActiveKeyIds = keys.filter((k) => k.status === "active").map((k) =>
    k.id
  );
  if (cachedActiveKeyIds.length === 0) {
    cachedCursor = 0;
    return;
  }
  cachedCursor = cachedCursor % cachedActiveKeyIds.length;
}

function getNextApiKeyFast(now: number): { key: string; id: string } | null {
  if (cachedActiveKeyIds.length === 0) return null;

  for (let offset = 0; offset < cachedActiveKeyIds.length; offset++) {
    const idx = (cachedCursor + offset) % cachedActiveKeyIds.length;
    const id = cachedActiveKeyIds[idx];
    const cooldownUntil = keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;

    const keyEntry = cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== "active") continue;

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
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
    ? Number.parseInt(retryAfter, 10) * 1000
    : 2000;
  keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}

function markKeyInvalid(id: string): void {
  const keyEntry = cachedKeysById.get(id);
  if (!keyEntry) return;
  if (keyEntry.status === "invalid") return;
  keyEntry.status = "invalid";
  dirtyKeyIds.add(id);
  keyCooldownUntil.delete(id);
  rebuildActiveKeyIds();
}

function getNextModelFast(): string | null {
  if (cachedModelPool.length === 0) {
    return null;
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

function pruneDisabledModels(
  disabledModels:
    | Record<string, { disabledAt?: unknown; reason?: unknown }>
    | undefined,
  now: number,
): Record<string, DisabledModelEntry> {
  if (!disabledModels) return {};

  const out: Record<string, DisabledModelEntry> = {};
  for (const [rawModel, entry] of Object.entries(disabledModels)) {
    const model = rawModel.trim();
    if (!model) continue;

    const disabledAt = typeof entry.disabledAt === "number"
      ? entry.disabledAt
      : Number(entry.disabledAt);
    if (!Number.isFinite(disabledAt) || disabledAt <= 0) continue;
    if (disabledAt > now) continue;
    if ((now - disabledAt) > DISABLED_MODEL_RETENTION_MS) continue;

    const reason =
      typeof entry.reason === "string" && entry.reason.trim().length > 0
        ? entry.reason.trim()
        : "model_not_found";

    const existing = out[model];
    if (!existing || disabledAt > existing.disabledAt) {
      out[model] = { disabledAt, reason };
    }
  }

  return out;
}

function safeJsonParse(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isModelNotFoundPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;

  if (!("error" in payload)) return false;
  const errorValue = (payload as { error?: unknown }).error;

  if (typeof errorValue === "string") {
    const lower = errorValue.toLowerCase();
    return lower.includes("model_not_found") ||
      lower.includes("model not found") ||
      lower.includes("no such model");
  }

  if (!errorValue || typeof errorValue !== "object") return false;

  const code = (errorValue as { code?: unknown }).code;
  if (code === "model_not_found") return true;

  const type = (errorValue as { type?: unknown }).type;
  if (type === "model_not_found") return true;

  const message = (errorValue as { message?: unknown }).message;
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    return lower.includes("model_not_found") ||
      lower.includes("model not found") ||
      lower.includes("no such model");
  }

  return false;
}

async function disableModel(model: string, reason: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;

  const now = Date.now();

  await kvUpdateConfig((config) => {
    const disabledModels = pruneDisabledModels(
      config.disabledModels as
        | Record<string, { disabledAt?: unknown; reason?: unknown }>
        | undefined,
      now,
    );

    disabledModels[trimmed] = {
      disabledAt: now,
      reason: reason?.trim() ? reason.trim() : "model_not_found",
    };

    return {
      ...config,
      disabledModels,
      schemaVersion: "4.0",
    };
  });

  rebuildModelPoolCache();
  console.warn(`[MODEL] disabled: ${trimmed}`);
}

function rebuildModelPoolCache(): void {
  const now = Date.now();
  const disabled = pruneDisabledModels(cachedConfig?.disabledModels, now);

  if (cachedConfig) {
    const existing = cachedConfig.disabledModels ?? {};
    const existingKeys = Object.keys(existing);
    const nextKeys = Object.keys(disabled);

    let changed = existingKeys.length !== nextKeys.length;

    if (!changed) {
      for (const k of nextKeys) {
        const v = existing[k];
        const n = disabled[k];
        if (!v || v.disabledAt !== n.disabledAt || v.reason !== n.reason) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      cachedConfig.disabledModels = disabled;
      cachedConfig.schemaVersion = "4.0";
      dirtyConfig = true;
    }
  }

  const basePool =
    cachedConfig && cachedConfig.modelPool && cachedConfig.modelPool.length > 0
      ? cachedConfig.modelPool
      : DEFAULT_MODEL_POOL;

  const seen = new Set<string>();
  cachedModelPool = basePool
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m.length > 0)
    .filter((m) => !(m in disabled))
    .filter((m) => {
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });

  if (cachedModelPool.length === 0) {
    const fallback = FALLBACK_MODEL.trim();
    if (fallback && !(fallback in disabled)) {
      cachedModelPool = [fallback];
    }
  }

  if (cachedModelPool.length > 0) {
    const idx = cachedConfig?.currentModelIndex ?? 0;
    modelCursor = idx % cachedModelPool.length;
    return;
  }

  modelCursor = 0;
}

async function flushDirtyToKv(): Promise<void> {
  // 清理过期的 cooldown 条目，防止内存泄漏（放在入口，确保低流量时也能清理）
  const now = Date.now();
  for (const [id, until] of keyCooldownUntil) {
    if (until < now) {
      keyCooldownUntil.delete(id);
    }
  }

  if (flushInProgress) return;
  if (!dirtyConfig && dirtyKeyIds.size === 0 && dirtyProxyKeyIds.size === 0) {
    return;
  }
  if (!cachedConfig) return;

  flushInProgress = true;
  const keyIds = Array.from(dirtyKeyIds);
  dirtyKeyIds.clear();
  const proxyKeyIds = Array.from(dirtyProxyKeyIds);
  dirtyProxyKeyIds.clear();
  const flushConfig = dirtyConfig;
  dirtyConfig = false;

  try {
    const tasks: Promise<unknown>[] = [];
    for (const id of keyIds) {
      const keyEntry = cachedKeysById.get(id);
      if (!keyEntry) continue;
      tasks.push(kv.set([...API_KEY_PREFIX, id], keyEntry));
    }
    for (const id of proxyKeyIds) {
      const pk = cachedProxyKeys.get(id);
      if (!pk) continue;
      tasks.push(kv.set([...PROXY_KEY_PREFIX, id], pk));
    }
    if (flushConfig) {
      tasks.push(kv.set(CONFIG_KEY, cachedConfig));
    }
    await Promise.all(tasks);
  } catch (error) {
    for (const id of keyIds) dirtyKeyIds.add(id);
    for (const id of proxyKeyIds) dirtyProxyKeyIds.add(id);
    dirtyConfig = dirtyConfig || flushConfig;
    console.error(`[KV] flush failed:`, error);
  } finally {
    flushInProgress = false;
  }
}

async function bootstrapCache(): Promise<void> {
  cachedConfig = await kvGetConfig();
  const keys = await kvGetAllKeys();
  cachedKeysById = new Map(keys.map((k) => [k.id, k]));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();

  const proxyKeys = await kvGetAllProxyKeys();
  cachedProxyKeys = new Map(proxyKeys.map((k) => [k.id, k]));
}

// ================================
// KV 存储操作
// ================================
async function kvEnsureConfigEntry(): Promise<Deno.KvEntry<ProxyConfig>> {
  let entry = await kv.get<ProxyConfig>(CONFIG_KEY);

  if (!entry.value) {
    const defaultConfig: ProxyConfig = {
      modelPool: [...DEFAULT_MODEL_POOL],
      currentModelIndex: 0,
      totalRequests: 0,
      kvFlushIntervalMs: DEFAULT_KV_FLUSH_INTERVAL_MS,
      schemaVersion: "4.0",
    };
    await kv.set(CONFIG_KEY, defaultConfig);
    entry = await kv.get<ProxyConfig>(CONFIG_KEY);
  }

  if (!entry.value) {
    throw new Error("KV 配置初始化失败");
  }
  return entry;
}

async function kvGetConfig(): Promise<ProxyConfig> {
  const entry = await kvEnsureConfigEntry();
  return entry.value;
}

async function kvUpdateConfig(
  updater: (config: ProxyConfig) => ProxyConfig | Promise<ProxyConfig>,
): Promise<ProxyConfig> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await kvEnsureConfigEntry();
    const nextConfig = await updater(entry.value);
    const result = await kv.atomic().check(entry).set(CONFIG_KEY, nextConfig)
      .commit();
    if (result.ok) {
      cachedConfig = nextConfig;
      return nextConfig;
    }
  }
  throw new Error("配置更新失败：达到最大重试次数");
}

function isModelCatalogFresh(catalog: ModelCatalog, now: number): boolean {
  return now >= catalog.fetchedAt &&
    (now - catalog.fetchedAt) < MODEL_CATALOG_TTL_MS;
}

async function kvGetModelCatalog(): Promise<ModelCatalog | null> {
  const entry = await kv.get<ModelCatalog>(MODEL_CATALOG_KEY);
  return entry.value ?? null;
}

async function refreshModelCatalog(): Promise<ModelCatalog> {
  if (modelCatalogFetchInFlight) {
    return await modelCatalogFetchInFlight;
  }

  modelCatalogFetchInFlight = (async () => {
    const response = await fetchWithTimeout(
      CEREBRAS_PUBLIC_MODELS_URL,
      {
        method: "GET",
        headers: { "Accept": "application/json" },
      },
      MODEL_CATALOG_FETCH_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const suffix = text && text.length <= 200 ? `: ${text}` : "";
      throw new Error(`模型目录拉取失败：HTTP ${response.status}${suffix}`);
    }

    const data = await response.json().catch(() => ({}));
    const rawModels = (data as { data?: unknown })?.data;

    const ids = Array.isArray(rawModels)
      ? rawModels
        .map((m) => {
          if (!m || typeof m !== "object") return "";
          if (!("id" in m)) return "";
          const id = (m as { id?: unknown }).id;
          return typeof id === "string" ? id.trim() : "";
        })
        .filter((id) => id.length > 0)
      : [];

    const seen = new Set<string>();
    const models: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }

    const catalog: ModelCatalog = {
      source: "cerebras-public",
      fetchedAt: Date.now(),
      models,
    };

    cachedModelCatalog = catalog;

    try {
      await kv.set(MODEL_CATALOG_KEY, catalog);
    } catch (error) {
      console.error(`[KV] model catalog save failed:`, error);
    }

    return catalog;
  })().finally(() => {
    modelCatalogFetchInFlight = null;
  });

  return await modelCatalogFetchInFlight;
}

async function kvGetAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const iter = kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ApiKey);
  }
  return keys;
}

async function kvAddKey(
  key: string,
): Promise<{ success: boolean; id?: string; error?: string }> {
  const allKeys = Array.from(cachedKeysById.values());
  const existingKey = allKeys.find((k) => k.key === key);
  if (existingKey) {
    return { success: false, error: "密钥已存在" };
  }

  const id = generateId();
  const newKey: ApiKey = {
    id,
    key,
    useCount: 0,
    status: "active",
    createdAt: Date.now(),
  };

  await kv.set([...API_KEY_PREFIX, id], newKey);
  cachedKeysById.set(id, newKey);
  rebuildActiveKeyIds();

  return { success: true, id };
}

async function kvDeleteKey(
  id: string,
): Promise<{ success: boolean; error?: string }> {
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

async function kvUpdateKey(
  id: string,
  updates: Partial<ApiKey>,
): Promise<void> {
  const key = [...API_KEY_PREFIX, id];
  const existing = cachedKeysById.get(id) ?? (await kv.get<ApiKey>(key)).value;
  if (!existing) return;
  const updated = { ...existing, ...updates };
  cachedKeysById.set(id, updated);
  rebuildActiveKeyIds();
  await kv.set(key, updated);
}

// 代理鉴权密钥 KV 操作
async function kvGetAllProxyKeys(): Promise<ProxyAuthKey[]> {
  const keys: ProxyAuthKey[] = [];
  const iter = kv.list({ prefix: PROXY_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ProxyAuthKey);
  }
  return keys;
}

async function kvAddProxyKey(
  name: string,
): Promise<{ success: boolean; id?: string; key?: string; error?: string }> {
  if (cachedProxyKeys.size >= MAX_PROXY_KEYS) {
    return {
      success: false,
      error: `最多只能创建 ${MAX_PROXY_KEYS} 个代理密钥`,
    };
  }

  const id = generateId();
  const key = generateProxyKey();
  const newKey: ProxyAuthKey = {
    id,
    key,
    name: name || `密钥 ${cachedProxyKeys.size + 1}`,
    useCount: 0,
    createdAt: Date.now(),
  };

  await kv.set([...PROXY_KEY_PREFIX, id], newKey);
  cachedProxyKeys.set(id, newKey);

  return { success: true, id, key };
}

async function kvDeleteProxyKey(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const key = [...PROXY_KEY_PREFIX, id];
  if (!cachedProxyKeys.has(id)) {
    return { success: false, error: "密钥不存在" };
  }

  await kv.delete(key);
  cachedProxyKeys.delete(id);
  dirtyProxyKeyIds.delete(id);
  return { success: true };
}

// ================================
// API 密钥测试
// ================================
async function testKey(
  id: string,
): Promise<{ success: boolean; status: string; error?: string }> {
  const apiKey = cachedKeysById.get(id);

  if (!apiKey) {
    return { success: false, status: "invalid", error: "密钥不存在" };
  }

  const testModel = cachedModelPool.length > 0
    ? cachedModelPool[0]
    : FALLBACK_MODEL;

  try {
    const response = await fetchWithTimeout(CEREBRAS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.key}`,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      }),
    }, UPSTREAM_TEST_TIMEOUT_MS);

    if (response.ok) {
      await kvUpdateKey(id, { status: "active" });
      return { success: true, status: "active" };
    } else {
      const nextStatus: ApiKey["status"] =
        (response.status === 401 || response.status === 403)
          ? "invalid"
          : "inactive";
      await kvUpdateKey(id, { status: nextStatus });
      return {
        success: false,
        status: nextStatus,
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error) {
    const msg = isAbortError(error) ? "请求超时" : getErrorMessage(error);
    await kvUpdateKey(id, { status: "inactive" });
    return { success: false, status: "inactive", error: msg };
  }
}

// ================================
// HTTP 处理函数
// ================================
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 鉴权 API（无需登录）
  if (path.startsWith("/api/auth/")) {
    if (req.method === "GET" && path === "/api/auth/status") {
      const hasPassword = await getAdminPassword() !== null;
      const token = req.headers.get("X-Admin-Token");
      const isLoggedIn = await verifyAdminToken(token);
      return jsonResponse({ hasPassword, isLoggedIn });
    }

    if (req.method === "POST" && path === "/api/auth/setup") {
      const hasPassword = await getAdminPassword() !== null;
      if (hasPassword) {
        return problemResponse("密码已设置", { status: 400, instance: path });
      }
      try {
        const { password } = await req.json();
        if (!password || password.length < 4) {
          return problemResponse("密码至少 4 位", {
            status: 400,
            instance: path,
          });
        }
        await setAdminPassword(password);
        const token = await createAdminToken();
        return jsonResponse({ success: true, token });
      } catch (error) {
        return problemResponse(getErrorMessage(error), {
          status: 400,
          instance: path,
        });
      }
    }

    if (req.method === "POST" && path === "/api/auth/login") {
      try {
        const { password } = await req.json();
        const valid = await verifyAdminPassword(password);
        if (!valid) {
          return problemResponse("密码错误", { status: 401, instance: path });
        }
        const token = await createAdminToken();
        return jsonResponse({ success: true, token });
      } catch (error) {
        return problemResponse(getErrorMessage(error), {
          status: 400,
          instance: path,
        });
      }
    }

    if (req.method === "POST" && path === "/api/auth/logout") {
      const token = req.headers.get("X-Admin-Token");
      if (token) {
        await kv.delete([...ADMIN_TOKEN_PREFIX, token]);
      }
      return jsonResponse({ success: true });
    }

    return problemResponse("Not Found", { status: 404, instance: path });
  }

  // 受保护的管理 API
  if (path.startsWith("/api/")) {
    if (!await isAdminAuthorized(req)) {
      return problemResponse("未登录", { status: 401, instance: path });
    }

    // ========== 代理鉴权密钥管理 ==========
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
      req.method === "GET" && path.startsWith("/api/proxy-keys/") &&
      path.endsWith("/export")
    ) {
      const id = path.split("/")[3];
      const pk = cachedProxyKeys.get(id);
      if (!pk) {
        return problemResponse("密钥不存在", { status: 404, instance: path });
      }
      return jsonResponse({ key: pk.key });
    }

    // ========== Cerebras API 密钥管理 ==========
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
      req.method === "GET" && path.startsWith("/api/keys/") &&
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
      req.method === "POST" && path.startsWith("/api/keys/") &&
      path.endsWith("/test")
    ) {
      const id = path.split("/")[3];
      const result = await testKey(id);
      return jsonResponse(result);
    }

    // ========== 统计和配置 ==========
    if (req.method === "GET" && path === "/api/stats") {
      const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
      const stats = {
        totalKeys: keys.length,
        activeKeys: keys.filter((k) => k.status === "active").length,
        totalRequests: config.totalRequests,
        keyUsage: keys.map((k) => ({
          id: k.id,
          maskedKey: maskKey(k.key),
          useCount: k.useCount,
          status: k.status,
        })),
      };
      return jsonResponse(stats);
    }

    if (req.method === "PATCH" && path === "/api/config") {
      try {
        const body = await req.json().catch(() => ({}));
        const raw = body.kvFlushIntervalMs;

        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          return problemResponse("kvFlushIntervalMs 必须为数字", {
            status: 400,
            instance: path,
          });
        }

        const normalized = normalizeKvFlushIntervalMs(raw);
        const next = await kvUpdateConfig((config) => ({
          ...config,
          kvFlushIntervalMs: normalized,
        }));

        applyKvFlushInterval(next);

        return jsonResponse({
          success: true,
          kvFlushIntervalMs: normalized,
          effectiveKvFlushIntervalMs: kvFlushIntervalMsEffective,
          kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
        });
      } catch (error) {
        return problemResponse(getErrorMessage(error), {
          status: 400,
          instance: path,
        });
      }
    }

    if (req.method === "GET" && path === "/api/config") {
      const config = await kvGetConfig();
      const configured = normalizeKvFlushIntervalMs(
        config.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS,
      );

      const effective = resolveKvFlushIntervalMs({
        ...config,
        kvFlushIntervalMs: configured,
      });

      return jsonResponse({
        ...config,
        kvFlushIntervalMs: configured,
        effectiveKvFlushIntervalMs: effective,
        kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
      });
    }

    // ========== 模型目录（catalog） ==========
    if (req.method === "GET" && path === "/api/models/catalog") {
      const now = Date.now();

      let catalog = cachedModelCatalog;
      if (!catalog || !isModelCatalogFresh(catalog, now)) {
        const kvCatalog = await kvGetModelCatalog();
        if (kvCatalog) {
          cachedModelCatalog = kvCatalog;
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
      let catalog = cachedModelCatalog ?? await kvGetModelCatalog();

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

    // ========== 模型池管理 ==========
    if (req.method === "GET" && path === "/api/models") {
      const config = await kvGetConfig();
      const models = config.modelPool?.length > 0
        ? config.modelPool
        : DEFAULT_MODEL_POOL;

      const now = Date.now();
      const disabledModels = pruneDisabledModels(
        config.disabledModels as
          | Record<
            string,
            { disabledAt?: unknown; reason?: unknown }
          >
          | undefined,
        now,
      );

      const seen = new Set<string>();
      let effectiveModels = models
        .map((m) => (typeof m === "string" ? m.trim() : ""))
        .filter((m) => m.length > 0)
        .filter((m) => !(m in disabledModels))
        .filter((m) => {
          if (seen.has(m)) return false;
          seen.add(m);
          return true;
        });

      if (effectiveModels.length === 0) {
        const fallback = FALLBACK_MODEL.trim();
        if (fallback && !(fallback in disabledModels)) {
          effectiveModels = [fallback];
        }
      }

      return jsonResponse({
        models,
        effectiveModels,
        disabledModels,
        disabledModelRetentionMs: DISABLED_MODEL_RETENTION_MS,
      });
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

    if (req.method === "POST" && path === "/api/models") {
      try {
        const { model } = await req.json();
        if (!model?.trim()) {
          return problemResponse("模型名称不能为空", {
            status: 400,
            instance: path,
          });
        }

        const trimmedModel = model.trim();
        if (cachedModelPool.includes(trimmedModel)) {
          return problemResponse("模型已存在", { status: 409, instance: path });
        }

        await kvUpdateConfig((config) => ({
          ...config,
          modelPool: [...config.modelPool, trimmedModel],
        }));
        rebuildModelPoolCache();

        return jsonResponse(
          { success: true, model: trimmedModel },
          { status: 201 },
        );
      } catch (error) {
        return problemResponse(getErrorMessage(error), {
          status: 400,
          instance: path,
        });
      }
    }

    if (req.method === "DELETE" && path === "/api/models/disabled") {
      try {
        await kvUpdateConfig((config) => ({
          ...config,
          disabledModels: {},
          schemaVersion: "4.0",
        }));
        rebuildModelPoolCache();
        return jsonResponse({ success: true });
      } catch (error) {
        return problemResponse(getErrorMessage(error), {
          status: 400,
          instance: path,
        });
      }
    }

    if (req.method === "DELETE" && path.startsWith("/api/models/disabled/")) {
      const encodedName = path.substring("/api/models/disabled/".length);
      const modelName = decodeURIComponent(encodedName).trim();
      if (!modelName) {
        return problemResponse("模型名称不能为空", {
          status: 400,
          instance: path,
        });
      }

      const now = Date.now();
      const currentDisabled = pruneDisabledModels(
        cachedConfig?.disabledModels as
          | Record<
            string,
            { disabledAt?: unknown; reason?: unknown }
          >
          | undefined,
        now,
      );
      if (!(modelName in currentDisabled)) {
        return problemResponse("模型未被禁用", { status: 404, instance: path });
      }

      try {
        await kvUpdateConfig((config) => {
          const disabledModels = pruneDisabledModels(
            config.disabledModels as
              | Record<
                string,
                { disabledAt?: unknown; reason?: unknown }
              >
              | undefined,
            now,
          );

          delete disabledModels[modelName];

          return {
            ...config,
            disabledModels,
            schemaVersion: "4.0",
          };
        });
        rebuildModelPoolCache();
        return jsonResponse({ success: true });
      } catch (error) {
        return problemResponse(getErrorMessage(error), {
          status: 400,
          instance: path,
        });
      }
    }

    if (req.method === "DELETE" && path.startsWith("/api/models/")) {
      const encodedName = path.substring("/api/models/".length);
      const modelName = decodeURIComponent(encodedName);

      if (!cachedModelPool.includes(modelName)) {
        return problemResponse("模型不存在", { status: 404, instance: path });
      }

      await kvUpdateConfig((config) => ({
        ...config,
        modelPool: config.modelPool.filter((m) => m !== modelName),
        currentModelIndex: 0,
      }));
      rebuildModelPoolCache();

      return jsonResponse({ success: true });
    }

    if (
      req.method === "POST" && path.startsWith("/api/models/") &&
      path.endsWith("/test")
    ) {
      const parts = path.split("/");
      const encodedName = parts[3];
      const modelName = decodeURIComponent(encodedName);

      const activeKey = Array.from(cachedKeysById.values()).find((k) =>
        k.status === "active"
      );
      if (!activeKey) {
        return problemResponse("没有可用的 API 密钥", {
          status: 400,
          instance: path,
        });
      }

      try {
        const response = await fetchWithTimeout(CEREBRAS_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${activeKey.key}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 1,
          }),
        }, UPSTREAM_TEST_TIMEOUT_MS);

        if (response.ok) {
          return jsonResponse({ success: true, status: "available" });
        } else {
          if (response.status === 401 || response.status === 403) {
            await kvUpdateKey(activeKey.id, { status: "invalid" });
          }
          return jsonResponse({
            success: false,
            status: "unavailable",
            error: `HTTP ${response.status}`,
          });
        }
      } catch (error) {
        const msg = isAbortError(error) ? "请求超时" : getErrorMessage(error);
        return jsonResponse({ success: false, status: "error", error: msg });
      }
    }

    return problemResponse("Not Found", { status: 404, instance: path });
  }

  // GET /v1/models - OpenAI 兼容
  if (req.method === "GET" && path === "/v1/models") {
    const now = Math.floor(Date.now() / 1000);
    return jsonResponse({
      object: "list",
      data: [{
        id: EXTERNAL_MODEL_ID,
        object: "model",
        created: now,
        owned_by: "cerebras",
      }],
    });
  }

  // POST /v1/chat/completions - 代理转发
  if (req.method === "POST" && path === "/v1/chat/completions") {
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
        const cooldowns = cachedActiveKeyIds.map((id) =>
          keyCooldownUntil.get(id) ?? 0
        ).filter((ms) => ms > now);
        const minCooldownUntil = cooldowns.length > 0
          ? Math.min(...cooldowns)
          : 0;
        const retryAfterSeconds = minCooldownUntil > now
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
                "Authorization": `Bearer ${apiKeyData.key}`,
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
          const lower = bodyText.toLowerCase();

          const modelNotFound = isModelNotFoundPayload(payload) ||
            lower.includes("model_not_found") ||
            lower.includes("model not found") ||
            lower.includes("no such model");

          if (modelNotFound) {
            lastModelNotFound = {
              status: apiResponse.status,
              statusText: apiResponse.statusText,
              headers: new Headers(apiResponse.headers),
              bodyText,
            };
            apiResponse.body?.cancel();

            await disableModel(targetModel, "model_not_found");
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

  // 主页
  if (path === "/" && req.method === "GET") {
    const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
    const proxyKeyCount = cachedProxyKeys.size;
    const stats = {
      totalKeys: keys.length,
      activeKeys: keys.filter((k) => k.status === "active").length,
      totalRequests: config.totalRequests,
      proxyAuthEnabled: proxyKeyCount > 0,
      proxyKeyCount,
    };

    const faviconDataUri =
      `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzA2YjZkNCIgZD0iTTIyIDRoLTkuNzdMMTEgLjM0YS41LjUgMCAwIDAtLjUtLjM0SDJhMiAyIDAgMCAwLTIgMnYxNmEyIDIgMCAwIDAgMiAyaDkuNjVMMTMgMjMuNjhhLjUuNSAwIDAgMCAuNDcuMzJIMjJhMiAyIDAgMCAwIDItMlY2YTIgMiAwIDAgMC0yLTJaTTcuNSAxNWE0LjUgNC41IDAgMSAxIDIuOTItNy45Mi41LjUgMCAxIDEtLjY1Ljc2QTMuNSAzLjUgMCAxIDAgMTEgMTFINy41YS41LjUgMCAwIDEgMC0xaDRhLjUuNSAwIDAgMSAuNS41QTQuNSA0LjUgMCAwIDEgNy41IDE1Wm0xMS45LTRhMTEuMjYgMTEuMjYgMCAwIDEtMS44NiAzLjI5IDYuNjcgNi42NyAwIDAgMS0xLjA3LTEuNDguNS41IDAgMCAwLS45My4zOCA4IDggMCAwIDAgMS4zNCAxLjg3IDguOSA4LjkgMCAwIDEtLjY1LjYyTDE0LjYyIDExWk0yMyAyMmExIDEgMCAwIDEtMSAxaC03LjRsMi43Ny0zLjE3YS40OS40OSAwIDAgMCAuMDktLjQ4bC0uOTEtMi42NmE5LjM2IDkuMzYgMCAwIDAgMS0uODljMSAxIDEuOTMgMS45MSAyLjEyIDIuMDhhLjUuNSAwIDAgMCAuNjgtLjc0IDQzLjQ4IDQzLjQ4IDAgMCAxLTIuMTMtMi4xIDExLjQ5IDExLjQ5IDAgMCAwIDIuMjItNGgxLjA2YS41LjUgMCAwIDAgMC0xSDE4VjkuNWEuNS41IDAgMCAwLTEgMHYuNWgtMi41YS40OS40OSAwIDAgMC0uMjEgMGwtMS43Mi01SDIyYTEgMSAwIDAgMSAxIDFaIi8+PC9zdmc+`;

    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cerebras Translator</title>
  <link rel="icon" type="image/svg+xml" href="${faviconDataUri}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* ========== 亮色主题（默认） ========== */
    body, body.light {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%);
      min-height: 100vh;
      padding: 40px 20px;
      color: #1e293b;
      transition: background 0.3s, color 0.3s;
    }
    body .container, body.light .container { max-width: 600px; margin: 0 auto; }
    body .header, body.light .header { text-align: center; margin-bottom: 24px; position: relative; }
    body .logo, body.light .logo { width: 48px; height: 48px; margin: 0 auto 12px; filter: drop-shadow(0 0 16px rgba(6, 182, 212, 0.5)); }
    body h1, body.light h1 { font-size: 22px; font-weight: 600; color: #1e293b; margin-bottom: 4px; }
    body h1 span, body.light h1 span { background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    body .subtitle, body.light .subtitle { font-size: 13px; color: #64748b; }
    body .card, body.light .card {
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(6, 182, 212, 0.15);
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
      overflow: hidden;
    }
    body .tabs, body.light .tabs { display: flex; border-bottom: 1px solid rgba(6, 182, 212, 0.15); background: rgba(248, 250, 252, 0.8); }
    body .tab, body.light .tab {
      flex: 1; padding: 12px 16px; text-align: center; font-size: 13px; font-weight: 500;
      color: #64748b; cursor: pointer; border: none; background: transparent;
      border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all 0.2s;
    }
    body .tab:hover, body.light .tab:hover { color: #475569; }
    body .tab.active, body.light .tab.active { color: #06b6d4; border-bottom-color: #06b6d4; background: rgba(6, 182, 212, 0.05); }
    body .tab-content, body.light .tab-content { display: none; padding: 20px; }
    body .tab-content.active, body.light .tab-content.active { display: block; }
    body .stats-row, body.light .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(6, 182, 212, 0.1); }
    body .stat-item, body.light .stat-item { text-align: center; padding: 10px; background: rgba(6, 182, 212, 0.06); border-radius: 8px; border: 1px solid rgba(6, 182, 212, 0.12); }
    body .stat-value, body.light .stat-value { font-size: 22px; font-weight: 600; background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    body .stat-label, body.light .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    body .form-group, body.light .form-group { margin-bottom: 14px; }
    body .form-group label, body.light .form-group label { display: block; margin-bottom: 4px; color: #475569; font-size: 12px; font-weight: 500; }
    body .form-control, body.light .form-control {
      width: 100%; padding: 10px 12px; background: rgba(248, 250, 252, 0.9); border: 1px solid rgba(6, 182, 212, 0.2);
      border-radius: 8px; font-size: 13px; color: #1e293b; font-family: 'Inter', sans-serif; transition: all 0.2s;
    }
    body .form-control::placeholder, body.light .form-control::placeholder { color: #94a3b8; }
    body .form-control:focus, body.light .form-control:focus { outline: none; border-color: #06b6d4; box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.15); }
    textarea.form-control { resize: vertical; min-height: 70px; }
    .btn {
      background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); color: #fff; border: none;
      padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 500;
      transition: all 0.2s; font-family: 'Inter', sans-serif; box-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(6, 182, 212, 0.4); }
    body .btn-outline, body.light .btn-outline { background: transparent; color: #0891b2; border: 1px solid rgba(6, 182, 212, 0.4); box-shadow: none; }
    body .btn-outline:hover, body.light .btn-outline:hover { background: rgba(6, 182, 212, 0.08); transform: none; }
    body .btn-danger, body.light .btn-danger { background: transparent; color: #dc2626; border: 1px solid rgba(220, 38, 38, 0.4); box-shadow: none; }
    body .btn-danger:hover, body.light .btn-danger:hover { background: rgba(220, 38, 38, 0.08); transform: none; }
    body .btn-success, body.light .btn-success { background: transparent; color: #16a34a; border: 1px solid rgba(22, 163, 74, 0.4); box-shadow: none; }
    body .btn-success:hover, body.light .btn-success:hover { background: rgba(22, 163, 74, 0.08); transform: none; }
    body .divider, body.light .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.15), transparent); margin: 16px 0; }
    body .list-item, body.light .list-item {
      background: rgba(248, 250, 252, 0.8); border: 1px solid rgba(6, 182, 212, 0.1); border-radius: 8px;
      padding: 10px 12px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s;
    }
    body .list-item:hover, body.light .list-item:hover { border-color: rgba(6, 182, 212, 0.2); background: rgba(255, 255, 255, 0.9); }
    .item-info { flex: 1; min-width: 0; }
    body .item-primary, body.light .item-primary { display: flex; align-items: center; gap: 6px; color: #334155; font-size: 11px; margin-bottom: 2px; flex-wrap: wrap; }
    .key-text { font-family: 'JetBrains Mono', monospace; word-break: break-all; }
    .key-actions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
    body .item-secondary, body.light .item-secondary { font-size: 10px; color: #64748b; display: flex; align-items: center; gap: 4px; }
    .status-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 500; text-transform: uppercase; }
    body .status-active, body.light .status-active { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
    body .status-inactive, body.light .status-inactive { background: rgba(202, 138, 4, 0.12); color: #ca8a04; }
    body .status-invalid, body.light .status-invalid { background: rgba(220, 38, 38, 0.12); color: #dc2626; }
    .item-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 10px; }
    .item-actions .btn { padding: 5px 8px; font-size: 10px; }
    body .btn-icon, body.light .btn-icon { background: none; border: none; padding: 4px; cursor: pointer; color: #64748b; transition: color 0.2s; display: inline-flex; align-items: center; justify-content: center; }
    body .btn-icon:hover, body.light .btn-icon:hover { color: #06b6d4; }
    body .notification, body.light .notification {
      position: fixed; top: 16px; right: 16px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(8px);
      border: 1px solid rgba(6, 182, 212, 0.2); border-radius: 8px; padding: 10px 16px; display: none; z-index: 10000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); font-size: 12px;
    }
    .notification.show { display: block; animation: slideIn 0.3s ease; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    body .notification.success, body.light .notification.success { color: #16a34a; border-color: rgba(22, 163, 74, 0.3); }
    body .notification.error, body.light .notification.error { color: #dc2626; border-color: rgba(220, 38, 38, 0.3); }
    body .hint, body.light .hint { font-size: 11px; color: #64748b; margin-top: 10px; }
    body .empty-state, body.light .empty-state { text-align: center; padding: 20px; color: #64748b; font-size: 12px; }
    body .section-title, body.light .section-title { font-size: 12px; font-weight: 500; color: #475569; margin-bottom: 10px; }
    .auth-badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 500; margin-left: 8px; }
    body .auth-on, body.light .auth-on { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
    body .auth-off, body.light .auth-off { background: rgba(202, 138, 4, 0.12); color: #ca8a04; }
    body .footer, body.light .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #64748b; }
    body .footer span, body.light .footer span { color: #06b6d4; }
    body #authOverlay, body.light #authOverlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%);
      display: flex; align-items: center; justify-content: center; z-index: 9999;
    }
    body .auth-card, body.light .auth-card {
      background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px); border: 1px solid rgba(6, 182, 212, 0.15);
      border-radius: 12px; padding: 32px; max-width: 340px; width: 90%; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    body .auth-card h2, body.light .auth-card h2 { color: #1e293b; }

    /* ========== 暗色主题 ========== */
    body.dark {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      color: #e2e8f0;
    }
    body.dark h1 { color: #f1f5f9; }
    body.dark .card {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(6, 182, 212, 0.2);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    }
    body.dark .tabs { background: rgba(15, 23, 42, 0.5); }
    body.dark .tab:hover { color: #94a3b8; }
    body.dark .stat-item { background: rgba(6, 182, 212, 0.08); border: 1px solid rgba(6, 182, 212, 0.15); }
    body.dark .form-group label { color: #94a3b8; }
    body.dark .form-control {
      background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(6, 182, 212, 0.25);
      color: #e2e8f0;
    }
    body.dark .form-control::placeholder { color: #475569; }
    body.dark .form-control:focus { box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2); }
    body.dark .btn-outline { color: #06b6d4; }
    body.dark .btn-outline:hover { background: rgba(6, 182, 212, 0.1); }
    body.dark .btn-danger { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    body.dark .btn-danger:hover { background: rgba(248, 113, 113, 0.1); }
    body.dark .btn-success { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); }
    body.dark .btn-success:hover { background: rgba(74, 222, 128, 0.1); }
    body.dark .divider { background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.2), transparent); }
    body.dark .list-item {
      background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(6, 182, 212, 0.1);
    }
    body.dark .list-item:hover { border-color: rgba(6, 182, 212, 0.25); background: rgba(15, 23, 42, 0.8); }
    body.dark .item-primary { color: #cbd5e1; }
    body.dark .status-active { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    body.dark .status-inactive { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    body.dark .status-invalid { background: rgba(248, 113, 113, 0.15); color: #f87171; }
    body.dark .notification {
      background: rgba(30, 41, 59, 0.95);
      border: 1px solid rgba(6, 182, 212, 0.3);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    body.dark .notification.success { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); }
    body.dark .notification.error { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    body.dark .section-title { color: #94a3b8; }
    body.dark .auth-on { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    body.dark .auth-off { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    body.dark .footer { color: #475569; }
    body.dark #authOverlay {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
    }
    body.dark .auth-card {
      background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(6, 182, 212, 0.25);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    body.dark .auth-card h2 { color: #f1f5f9; }

    /* ========== 主题切换按钮 ========== */
    .theme-toggle {
      position: absolute; top: 0; right: 0;
      background: none; border: none; cursor: pointer; padding: 8px;
      color: #64748b; transition: color 0.2s;
    }
    .theme-toggle:hover { color: #06b6d4; }
    .theme-toggle svg { width: 20px; height: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <button class="theme-toggle" onclick="toggleTheme()" title="切换主题">
        <svg id="sunIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <svg id="moonIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path fill="#06b6d4" d="M22 4h-9.77L11 .34a.5.5 0 0 0-.5-.34H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9.65L13 23.68a.5.5 0 0 0 .47.32H22a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM7.5 15a4.5 4.5 0 1 1 2.92-7.92.5.5 0 1 1-.65.76A3.5 3.5 0 1 0 11 11H7.5a.5.5 0 0 1 0-1h4a.5.5 0 0 1 .5.5A4.5 4.5 0 0 1 7.5 15Zm11.9-4a11.26 11.26 0 0 1-1.86 3.29 6.67 6.67 0 0 1-1.07-1.48.5.5 0 0 0-.93.38 8 8 0 0 0 1.34 1.87 8.9 8.9 0 0 1-.65.62L14.62 11ZM23 22a1 1 0 0 1-1 1h-7.4l2.77-3.17a.49.49 0 0 0 .09-.48l-.91-2.66a9.36 9.36 0 0 0 1-.89c1 1 1.93 1.91 2.12 2.08a.5.5 0 0 0 .68-.74 43.48 43.48 0 0 1-2.13-2.1 11.49 11.49 0 0 0 2.22-4h1.06a.5.5 0 0 0 0-1H18V9.5a.5.5 0 0 0-1 0v.5h-2.5a.49.49 0 0 0-.21 0l-1.72-5H22a1 1 0 0 1 1 1Z"/>
        </svg>
      </div>
      <h1><span>Cerebras</span> Translator</h1>
      <p class="subtitle">基于大善人的翻译用中转服务</p>
    </div>

    <div class="card">
      <div class="tabs">
        <button class="tab active" onclick="switchTab('keys')">API 密钥</button>
        <button class="tab" onclick="switchTab('models')">模型配置</button>
        <button class="tab" onclick="switchTab('access')">访问控制</button>
      </div>

      <div id="keysTab" class="tab-content active">
        <div class="stats-row">
          <div class="stat-item">
            <div class="stat-value">${stats.totalKeys}</div>
            <div class="stat-label">总密钥</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${stats.activeKeys}</div>
            <div class="stat-label">活跃</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${stats.totalRequests}</div>
            <div class="stat-label">请求数</div>
          </div>
        </div>

        <div class="form-group">
          <label>添加 Cerebras API 密钥</label>
          <input type="text" id="singleKey" class="form-control" placeholder="输入 Cerebras API 密钥">
          <button class="btn" onclick="addSingleKey()" style="margin-top: 8px;">添加</button>
        </div>

        <div class="divider"></div>

        <div class="form-group">
          <label>批量导入</label>
          <textarea id="batchKeys" class="form-control" placeholder="每行一个密钥"></textarea>
          <button class="btn" onclick="addBatchKeys()" style="margin-top: 8px;">导入</button>
        </div>

        <div class="divider"></div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span class="section-title" style="margin: 0;">密钥列表</span>
          <button class="btn btn-outline" onclick="exportAllKeys()">导出全部</button>
        </div>
        <div id="keysContainer"></div>
      </div>

      <div id="modelsTab" class="tab-content">
        <p class="hint" style="margin-top: 0; margin-bottom: 14px;">模型池轮询，分散 TPM 负载</p>

        <div class="section-title">可用模型目录</div>
        <div class="form-group">
          <label>搜索</label>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="modelCatalogSearch" class="form-control" placeholder="搜索模型（例如 qwen / llama / glm）" style="flex: 1;">
            <button class="btn btn-outline" onclick="refreshModelCatalog()" id="refreshModelCatalogBtn">刷新</button>
          </div>
          <p class="hint" id="modelCatalogHint">加载中...</p>
        </div>

        <div id="modelCatalogContainer"></div>
        <button class="btn" onclick="saveModelPoolFromSelection()" style="margin-top: 8px;" id="saveModelPoolBtn">保存模型池</button>

        <div class="divider"></div>
        <div class="form-group">
          <label>高级：手动添加自定义模型</label>
          <input type="text" id="newModel" class="form-control" placeholder="例如 llama-3.3-70b">
          <button class="btn" onclick="addModel()" style="margin-top: 8px;">添加</button>
        </div>

        <div class="divider"></div>
        <div class="section-title">当前模型池（配置）</div>
        <div id="modelsContainer"></div>

        <div class="divider"></div>
        <div class="section-title">生效模型池（自动排除禁用模型）</div>
        <div id="effectiveModelsContainer"></div>

        <div class="divider"></div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span class="section-title" style="margin: 0;">已禁用模型（自动自愈）</span>
          <button class="btn btn-outline" onclick="clearDisabledModels()" id="clearDisabledModelsBtn">清空禁用列表</button>
        </div>
        <p class="hint" id="disabledModelsHint" style="margin-top: 0;">加载中...</p>
        <div id="disabledModelsContainer"></div>
      </div>

      <div id="accessTab" class="tab-content">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <div>
            <span class="section-title" style="margin: 0;">代理访问密钥</span>
            <span id="authBadge" class="auth-badge ${
        stats.proxyAuthEnabled ? "auth-on" : "auth-off"
      }">${stats.proxyAuthEnabled ? "鉴权已开启" : "公开访问"}</span>
          </div>
          <span style="font-size: 11px; color: #64748b;" id="keyCountLabel">${stats.proxyKeyCount}/${MAX_PROXY_KEYS}</span>
        </div>
        <p class="hint" style="margin-top: 0; margin-bottom: 14px;">创建密钥后自动开启鉴权；删除所有密钥则变为公开访问</p>

        <div class="form-group">
          <label>密钥名称（可选）</label>
          <input type="text" id="proxyKeyName" class="form-control" placeholder="例如：移动端应用">
          <button class="btn" onclick="createProxyKey()" style="margin-top: 8px;" id="createProxyKeyBtn">创建密钥</button>
        </div>

        <div class="divider"></div>
        <div class="section-title">已创建的密钥</div>
        <div id="proxyKeysContainer"></div>

        <div class="divider"></div>
        <div class="section-title">高级设置</div>
        <div class="form-group">
          <label>KV 刷盘间隔（ms）</label>
          <input type="number" id="kvFlushIntervalMs" class="form-control" min="1000" step="100" placeholder="例如 15000">
          <button class="btn btn-outline" onclick="saveKvFlushIntervalMs()" style="margin-top: 8px;">保存</button>
          <p class="hint" id="kvFlushIntervalHint">最小 1000ms。用于控制统计/用量写回 KV 的频率。</p>
        </div>
      </div>
    </div>

    <div class="footer">Endpoint: <span>/v1/chat/completions</span></div>
    <div class="notification" id="notification"></div>
  </div>

  <div id="authOverlay">
    <div class="auth-card">
      <div style="text-align: center; margin-bottom: 20px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width: 40px; height: 40px; margin-bottom: 8px; filter: drop-shadow(0 0 12px rgba(6, 182, 212, 0.5));">
          <path fill="#06b6d4" d="M22 4h-9.77L11 .34a.5.5 0 0 0-.5-.34H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9.65L13 23.68a.5.5 0 0 0 .47.32H22a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM7.5 15a4.5 4.5 0 1 1 2.92-7.92.5.5 0 1 1-.65.76A3.5 3.5 0 1 0 11 11H7.5a.5.5 0 0 1 0-1h4a.5.5 0 0 1 .5.5A4.5 4.5 0 0 1 7.5 15Zm11.9-4a11.26 11.26 0 0 1-1.86 3.29 6.67 6.67 0 0 1-1.07-1.48.5.5 0 0 0-.93.38 8 8 0 0 0 1.34 1.87 8.9 8.9 0 0 1-.65.62L14.62 11ZM23 22a1 1 0 0 1-1 1h-7.4l2.77-3.17a.49.49 0 0 0 .09-.48l-.91-2.66a9.36 9.36 0 0 0 1-.89c1 1 1.93 1.91 2.12 2.08a.5.5 0 0 0 .68-.74 43.48 43.48 0 0 1-2.13-2.1 11.49 11.49 0 0 0 2.22-4h1.06a.5.5 0 0 0 0-1H18V9.5a.5.5 0 0 0-1 0v.5h-2.5a.49.49 0 0 0-.21 0l-1.72-5H22a1 1 0 0 1 1 1Z"/>
        </svg>
        <h2 style="color: #f1f5f9; font-size: 18px;"><span style="background: linear-gradient(135deg, #06b6d4, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Cerebras</span> Translator</h2>
      </div>
      <p id="authTitle" style="color: #94a3b8; font-size: 12px; text-align: center; margin-bottom: 20px;">加载中...</p>
      <div class="form-group">
        <label id="passwordLabel">密码</label>
        <input type="password" id="authPassword" class="form-control" placeholder="输入密码">
      </div>
      <div id="confirmGroup" class="form-group" style="display: none;">
        <label>确认密码</label>
        <input type="password" id="authConfirm" class="form-control" placeholder="再次输入密码">
      </div>
      <button class="btn" id="authBtn" onclick="handleAuth()" style="width: 100%; padding: 10px; font-size: 13px;">提交</button>
      <p id="authError" style="color: #f87171; font-size: 11px; text-align: center; margin-top: 10px; display: none;"></p>
    </div>
  </div>

  <script>
    let adminToken = localStorage.getItem('adminToken') || '';
    let authMode = 'login';
    const MAX_PROXY_KEYS = ${MAX_PROXY_KEYS};

    let currentModelPool = [];
    let effectiveModelPool = [];
    let disabledModelsState = null;
    let disabledModelRetentionMs = 0;
    let modelCatalogState = null;

    // 主题管理
    function loadTheme() {
      const saved = localStorage.getItem('theme') || 'light';
      document.body.className = saved;
      updateThemeIcon();
    }

    function toggleTheme() {
      const current = document.body.classList.contains('dark') ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.body.className = next;
      localStorage.setItem('theme', next);
      updateThemeIcon();
    }

    function updateThemeIcon() {
      const isDark = document.body.classList.contains('dark');
      document.getElementById('sunIcon').style.display = isDark ? 'none' : 'block';
      document.getElementById('moonIcon').style.display = isDark ? 'block' : 'none';
    }

    loadTheme();

    function getAuthHeaders() { return { 'X-Admin-Token': adminToken }; }

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tabs = ['keys', 'models', 'access'];
      const idx = tabs.indexOf(tab);
      if (idx >= 0) {
        document.querySelectorAll('.tab')[idx].classList.add('active');
        document.getElementById(tab + 'Tab').classList.add('active');
      }
    }

    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showAuthError(getApiErrorMessage(res, data));
          return;
        }
        if (!data.hasPassword) {
          authMode = 'setup';
          document.getElementById('authTitle').textContent = '首次使用，请设置管理密码';
          document.getElementById('passwordLabel').textContent = '新密码（至少 4 位）';
          document.getElementById('confirmGroup').style.display = 'block';
          document.getElementById('authBtn').textContent = '设置密码';
          document.getElementById('authOverlay').style.display = 'flex';
        } else if (!data.isLoggedIn) {
          authMode = 'login';
          document.getElementById('authTitle').textContent = '请登录以继续';
          document.getElementById('passwordLabel').textContent = '密码';
          document.getElementById('confirmGroup').style.display = 'none';
          document.getElementById('authBtn').textContent = '登录';
          document.getElementById('authOverlay').style.display = 'flex';
        } else {
          document.getElementById('authOverlay').style.display = 'none';
          loadProxyKeys();
          loadKeys();
          loadModelCatalog();
          loadModels();
          loadConfig();
        }
      } catch (e) { showAuthError('检查登录状态失败'); }
    }

    function showAuthError(msg) {
      const el = document.getElementById('authError');
      el.textContent = msg;
      el.style.display = 'block';
    }

    async function handleAuth() {
      const password = document.getElementById('authPassword').value;
      document.getElementById('authError').style.display = 'none';
      if (authMode === 'setup') {
        const confirm = document.getElementById('authConfirm').value;
        if (password.length < 4) { showAuthError('密码至少 4 位'); return; }
        if (password !== confirm) { showAuthError('两次密码不一致'); return; }
        try {
          const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAuthError(getApiErrorMessage(res, data) || '设置失败');
            return;
          }
          if (data.success && data.token) { adminToken = data.token; localStorage.setItem('adminToken', adminToken); checkAuth(); }
          else showAuthError('设置失败');
        } catch (e) { showAuthError('错误: ' + formatClientError(e)); }
      } else {
        try {
          const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAuthError(getApiErrorMessage(res, data) || '登录失败');
            return;
          }
          if (data.success && data.token) { adminToken = data.token; localStorage.setItem('adminToken', adminToken); checkAuth(); }
          else showAuthError('登录失败');
        } catch (e) { showAuthError('错误: ' + formatClientError(e)); }
      }
    }

    document.getElementById('authPassword').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') { if (authMode === 'setup') document.getElementById('authConfirm').focus(); else handleAuth(); }
    });
    document.getElementById('authConfirm')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAuth(); });

    let notificationTimer = null;
    function showNotification(message, type = 'success') {
      const notif = document.getElementById('notification');
      if (!notif) { alert(message); return; }
      if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
      }
      notif.textContent = message;
      notif.className = 'notification show ' + type;
      notif.style.display = 'block';
      notif.style.zIndex = '10000';
      notificationTimer = setTimeout(() => {
        notif.classList.remove('show');
        notif.style.display = 'none';
        notificationTimer = null;
      }, 3000);
    }

    function formatClientError(error) {
      if (!error) return '未知错误';
      if (error.name === 'AbortError') return '请求超时，请稍后重试';
      const msg = error.message || String(error);
      const lower = msg.toLowerCase();
      if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('err_connection_refused')) {
        return '无法连接到本地服务（' + location.origin + '），请确认 Deno 服务在运行且端口可访问';
      }
      return msg;
    }

    async function fetchJsonWithTimeout(url, options, timeoutMs = 15000) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const text = await res.text();
        let data = {};
        if (text) {
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
        }
        return { res, data };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function getApiErrorMessage(res, data) {
      if (data && typeof data.detail === 'string' && data.detail.trim()) return data.detail;
      if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
      if (data && typeof data.title === 'string' && data.title.trim()) return data.title;
      if (data && typeof data.message === 'string' && data.message.trim()) return data.message;
      return 'HTTP ' + res.status;
    }

    function handleUnauthorized(res) {
      if (res.status !== 401) return false;
      adminToken = '';
      localStorage.removeItem('adminToken');
      checkAuth();
      return true;
    }

    function setButtonLoading(btn, loading, text) {
      if (!btn) return;
      if (loading) {
        btn.dataset.oldText = btn.textContent || '';
        btn.textContent = text || '处理中...';
        btn.disabled = true;
        return;
      }
      btn.textContent = btn.dataset.oldText || btn.textContent || '';
      delete btn.dataset.oldText;
      btn.disabled = false;
    }

    // 配置管理
    async function loadConfig() {
      try {
        const res = await fetch('/api/config', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载配置失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const input = document.getElementById('kvFlushIntervalMs');
        if (input) {
          input.value = String(data.kvFlushIntervalMs ?? '');
          if (data.kvFlushIntervalMinMs) input.min = String(data.kvFlushIntervalMinMs);
        }

        const hint = document.getElementById('kvFlushIntervalHint');
        if (hint) {
          const effective = data.effectiveKvFlushIntervalMs ?? data.kvFlushIntervalMs;
          hint.textContent = '当前生效：' + String(effective ?? '') + 'ms';
        }
      } catch (e) {
        showNotification('加载配置失败: ' + formatClientError(e), 'error');
      }
    }

    async function saveKvFlushIntervalMs() {
      const el = document.getElementById('kvFlushIntervalMs');
      const raw = el ? el.value : '';
      const ms = Number(raw);
      const min = Number(el?.min || '1000');

      if (!Number.isFinite(ms)) {
        showNotification('请输入合法数字', 'error');
        return;
      }
      if (ms < min) {
        showNotification('最小 ' + String(min) + 'ms', 'error');
        return;
      }

      try {
        const res = await fetch('/api/config', {
          method: 'PATCH',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ kvFlushIntervalMs: ms }),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '保存失败', 'error');
          return;
        }
        showNotification('已保存');
        loadConfig();
      } catch (e) {
        showNotification('保存失败: ' + formatClientError(e), 'error');
      }
    }

    // 代理密钥管理
    async function loadProxyKeys() {
      try {
        const res = await fetch('/api/proxy-keys', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const container = document.getElementById('proxyKeysContainer');
        const badge = document.getElementById('authBadge');
        const countLabel = document.getElementById('keyCountLabel');
        const createBtn = document.getElementById('createProxyKeyBtn');

        countLabel.textContent = (data.keys?.length || 0) + '/' + MAX_PROXY_KEYS;
        createBtn.disabled = (data.keys?.length || 0) >= MAX_PROXY_KEYS;

        if (data.authEnabled) {
          badge.className = 'auth-badge auth-on';
          badge.textContent = '鉴权已开启';
        } else {
          badge.className = 'auth-badge auth-off';
          badge.textContent = '公开访问';
        }

        if (data.keys?.length > 0) {
          container.textContent = '';

          for (const k of data.keys) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const keySpan = document.createElement('span');
            keySpan.className = 'key-text';
            keySpan.id = 'pk-' + k.id;
            keySpan.textContent = String(k.key ?? '');

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn-icon';
            toggleBtn.title = '查看完整密钥';
            toggleBtn.addEventListener('click', () => toggleProxyKeyVisibility(k.id));

            const svgNs = 'http://www.w3.org/2000/svg';

            const eyeIcon = document.createElementNS(svgNs, 'svg');
            eyeIcon.id = 'pk-eye-' + k.id;
            eyeIcon.setAttribute('xmlns', svgNs);
            eyeIcon.setAttribute('width', '12');
            eyeIcon.setAttribute('height', '12');
            eyeIcon.setAttribute('viewBox', '0 0 24 24');
            eyeIcon.setAttribute('fill', 'none');
            eyeIcon.setAttribute('stroke', 'currentColor');
            eyeIcon.setAttribute('stroke-width', '2');

            const eyePath = document.createElementNS(svgNs, 'path');
            eyePath.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');

            const eyeCircle = document.createElementNS(svgNs, 'circle');
            eyeCircle.setAttribute('cx', '12');
            eyeCircle.setAttribute('cy', '12');
            eyeCircle.setAttribute('r', '3');

            eyeIcon.appendChild(eyePath);
            eyeIcon.appendChild(eyeCircle);

            const eyeOffIcon = document.createElementNS(svgNs, 'svg');
            eyeOffIcon.id = 'pk-eye-off-' + k.id;
            eyeOffIcon.setAttribute('xmlns', svgNs);
            eyeOffIcon.setAttribute('width', '12');
            eyeOffIcon.setAttribute('height', '12');
            eyeOffIcon.setAttribute('viewBox', '0 0 24 24');
            eyeOffIcon.setAttribute('fill', 'none');
            eyeOffIcon.setAttribute('stroke', 'currentColor');
            eyeOffIcon.setAttribute('stroke-width', '2');
            eyeOffIcon.style.display = 'none';

            const eyeOffPath = document.createElementNS(svgNs, 'path');
            eyeOffPath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24');

            const eyeOffLine = document.createElementNS(svgNs, 'line');
            eyeOffLine.setAttribute('x1', '1');
            eyeOffLine.setAttribute('y1', '1');
            eyeOffLine.setAttribute('x2', '23');
            eyeOffLine.setAttribute('y2', '23');

            eyeOffIcon.appendChild(eyeOffPath);
            eyeOffIcon.appendChild(eyeOffLine);

            toggleBtn.appendChild(eyeIcon);
            toggleBtn.appendChild(eyeOffIcon);

            primary.appendChild(keySpan);
            primary.appendChild(toggleBtn);

            const secondary = document.createElement('div');
            secondary.className = 'item-secondary';
            secondary.textContent = String(k.name ?? '') + ' · 已使用 ' + String(k.useCount ?? 0) + ' 次';

            info.appendChild(primary);
            info.appendChild(secondary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-outline';
            copyBtn.textContent = '复制';
            copyBtn.addEventListener('click', () => copyProxyKey(k.id));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', () => deleteProxyKey(k.id));

            actions.appendChild(copyBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '暂无代理密钥，API 当前为公开访问';
          container.appendChild(empty);
        }
      } catch (e) { showNotification('加载失败: ' + formatClientError(e), 'error'); }
    }

    async function createProxyKey() {
      const name = document.getElementById('proxyKeyName').value.trim();
      try {
        const res = await fetch('/api/proxy-keys', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '创建失败', 'error');
          return;
        }

        showNotification('密钥已创建，请立即复制保存');
        document.getElementById('proxyKeyName').value = '';
        loadProxyKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function deleteProxyKey(id) {
      if (!confirm('删除此密钥？使用此密钥的客户端将无法访问')) return;
      try {
        const res = await fetch('/api/proxy-keys/' + id, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '删除失败', 'error');
          return;
        }
        showNotification('密钥已删除');
        loadProxyKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    const proxyKeyFullValues = {};
    async function toggleProxyKeyVisibility(id) {
      const keySpan = document.getElementById('pk-' + id);
      const eyeIcon = document.getElementById('pk-eye-' + id);
      const eyeOffIcon = document.getElementById('pk-eye-off-' + id);
      if (eyeIcon.style.display !== 'none') {
        if (!proxyKeyFullValues[id]) {
          try {
            const res = await fetch('/api/proxy-keys/' + id + '/export', { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (handleUnauthorized(res)) return;
            if (res.ok && data.key) proxyKeyFullValues[id] = data.key;
          } catch (e) { return; }
        }
        if (proxyKeyFullValues[id]) {
          keySpan.textContent = proxyKeyFullValues[id];
          eyeIcon.style.display = 'none';
          eyeOffIcon.style.display = 'inline';
        }
      } else { loadProxyKeys(); }
    }

    async function copyProxyKey(id) {
      try {
        const res = await fetch('/api/proxy-keys/' + id + '/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '复制失败', 'error');
          return;
        }
        if (data.key) { await navigator.clipboard.writeText(data.key); showNotification('密钥已复制'); }
        else showNotification('复制失败', 'error');
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    // API 密钥管理
    async function addSingleKey() {
      const key = document.getElementById('singleKey').value.trim();
      if (!key) { showNotification('请输入密钥', 'error'); return; }
      try {
        const res = await fetch('/api/keys', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '添加失败', 'error');
          return;
        }
        showNotification('密钥已添加');
        document.getElementById('singleKey').value = '';
        loadKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function addBatchKeys() {
      const input = document.getElementById('batchKeys').value.trim();
      if (!input) { showNotification('请输入密钥', 'error'); return; }
      try {
        const res = await fetch('/api/keys/batch', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '导入失败', 'error');
          return;
        }
        if (data.summary) { showNotification(\`导入完成：\${data.summary.success} 成功，\${data.summary.failed} 失败\`); document.getElementById('batchKeys').value = ''; loadKeys(); }
        else showNotification('导入失败', 'error');
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function loadKeys() {
      try {
        const res = await fetch('/api/keys', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const container = document.getElementById('keysContainer');
        if (data.keys?.length > 0) {
          container.textContent = '';

          for (const k of data.keys) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const keySpan = document.createElement('span');
            keySpan.className = 'key-text';
            keySpan.id = 'key-' + k.id;
            keySpan.textContent = String(k.key ?? '');

            const keyActions = document.createElement('span');
            keyActions.className = 'key-actions';

            const svgNs = 'http://www.w3.org/2000/svg';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn-icon';
            toggleBtn.title = '查看完整密钥';
            toggleBtn.addEventListener('click', () => toggleKeyVisibility(k.id));

            const eyeIcon = document.createElementNS(svgNs, 'svg');
            eyeIcon.id = 'eye-' + k.id;
            eyeIcon.setAttribute('xmlns', svgNs);
            eyeIcon.setAttribute('width', '14');
            eyeIcon.setAttribute('height', '14');
            eyeIcon.setAttribute('viewBox', '0 0 24 24');
            eyeIcon.setAttribute('fill', 'none');
            eyeIcon.setAttribute('stroke', 'currentColor');
            eyeIcon.setAttribute('stroke-width', '2');

            const eyePath = document.createElementNS(svgNs, 'path');
            eyePath.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');

            const eyeCircle = document.createElementNS(svgNs, 'circle');
            eyeCircle.setAttribute('cx', '12');
            eyeCircle.setAttribute('cy', '12');
            eyeCircle.setAttribute('r', '3');

            eyeIcon.appendChild(eyePath);
            eyeIcon.appendChild(eyeCircle);

            const eyeOffIcon = document.createElementNS(svgNs, 'svg');
            eyeOffIcon.id = 'eye-off-' + k.id;
            eyeOffIcon.setAttribute('xmlns', svgNs);
            eyeOffIcon.setAttribute('width', '14');
            eyeOffIcon.setAttribute('height', '14');
            eyeOffIcon.setAttribute('viewBox', '0 0 24 24');
            eyeOffIcon.setAttribute('fill', 'none');
            eyeOffIcon.setAttribute('stroke', 'currentColor');
            eyeOffIcon.setAttribute('stroke-width', '2');
            eyeOffIcon.style.display = 'none';

            const eyeOffPath = document.createElementNS(svgNs, 'path');
            eyeOffPath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24');

            const eyeOffLine = document.createElementNS(svgNs, 'line');
            eyeOffLine.setAttribute('x1', '1');
            eyeOffLine.setAttribute('y1', '1');
            eyeOffLine.setAttribute('x2', '23');
            eyeOffLine.setAttribute('y2', '23');

            eyeOffIcon.appendChild(eyeOffPath);
            eyeOffIcon.appendChild(eyeOffLine);

            toggleBtn.appendChild(eyeIcon);
            toggleBtn.appendChild(eyeOffIcon);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-icon';
            copyBtn.title = '复制密钥';
            copyBtn.addEventListener('click', () => copyKey(k.id));

            const copySvg = document.createElementNS(svgNs, 'svg');
            copySvg.setAttribute('xmlns', svgNs);
            copySvg.setAttribute('width', '14');
            copySvg.setAttribute('height', '14');
            copySvg.setAttribute('viewBox', '0 0 24 24');
            copySvg.setAttribute('fill', 'none');
            copySvg.setAttribute('stroke', 'currentColor');
            copySvg.setAttribute('stroke-width', '2');

            const copyRect = document.createElementNS(svgNs, 'rect');
            copyRect.setAttribute('x', '9');
            copyRect.setAttribute('y', '9');
            copyRect.setAttribute('width', '13');
            copyRect.setAttribute('height', '13');
            copyRect.setAttribute('rx', '2');
            copyRect.setAttribute('ry', '2');

            const copyPath = document.createElementNS(svgNs, 'path');
            copyPath.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

            copySvg.appendChild(copyRect);
            copySvg.appendChild(copyPath);
            copyBtn.appendChild(copySvg);

            keyActions.appendChild(toggleBtn);
            keyActions.appendChild(copyBtn);

            primary.appendChild(keySpan);
            primary.appendChild(keyActions);

            const secondary = document.createElement('div');
            secondary.className = 'item-secondary';

            const statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + String(k.status ?? '');
            statusBadge.textContent = String(k.status ?? '');

            secondary.appendChild(statusBadge);
            secondary.appendChild(document.createTextNode(' · 已使用 ' + String(k.useCount ?? 0) + ' 次'));

            info.appendChild(primary);
            info.appendChild(secondary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const testBtn = document.createElement('button');
            testBtn.className = 'btn btn-success';
            testBtn.textContent = '测试';
            testBtn.addEventListener('click', () => testKey(k.id, testBtn));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', () => deleteKey(k.id));

            actions.appendChild(testBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '暂无 API 密钥';
          container.appendChild(empty);
        }
      } catch (e) { showNotification('加载失败: ' + formatClientError(e), 'error'); }
    }

    async function copyKey(id) {
      try {
        const res = await fetch('/api/keys/' + id + '/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '复制失败', 'error');
          return;
        }
        if (data.key) {
          await navigator.clipboard.writeText(data.key);
          showNotification('密钥已复制');
        } else {
          showNotification('复制失败', 'error');
        }
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    const keyFullValues = {};
    async function toggleKeyVisibility(id) {
      const keySpan = document.getElementById('key-' + id);
      const eyeIcon = document.getElementById('eye-' + id);
      const eyeOffIcon = document.getElementById('eye-off-' + id);
      if (eyeIcon.style.display !== 'none') {
        if (!keyFullValues[id]) {
          try {
            const res = await fetch('/api/keys/' + id + '/export', { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (handleUnauthorized(res)) return;
            if (res.ok && data.key) keyFullValues[id] = data.key;
          } catch (e) { return; }
        }
        if (keyFullValues[id]) { keySpan.textContent = keyFullValues[id]; eyeIcon.style.display = 'none'; eyeOffIcon.style.display = 'inline'; }
      } else { loadKeys(); }
    }

    async function deleteKey(id) {
      if (!confirm('删除此密钥？')) return;
      try {
        const res = await fetch('/api/keys/' + id, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '删除失败', 'error');
          return;
        }
        showNotification('密钥已删除');
        loadKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function testKey(id, btn) {
      setButtonLoading(btn, true, '测试中...');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/keys/' + id + '/test', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('密钥测试失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        if (data.success) {
          showNotification('密钥有效', 'success');
        } else {
          const detail = data.error || data.status || (res.ok ? '' : ('HTTP ' + res.status));
          if (data.status === 'invalid') showNotification('密钥失效: ' + detail, 'error');
          else showNotification('密钥不可用: ' + detail, 'error');
        }
        loadKeys();
      } catch (e) {
        showNotification('密钥测试失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function exportAllKeys() {
      try {
        const res = await fetch('/api/keys/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '导出失败', 'error');
          return;
        }
        if (data.keys?.length > 0) { await navigator.clipboard.writeText(data.keys.join('\\n')); showNotification(\`\${data.keys.length} 个密钥已复制\`); }
        else showNotification('没有密钥可导出', 'error');
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    // 模型管理
    function formatTimestamp(ms) {
      try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
    }

    function renderEffectiveModels() {
      const container = document.getElementById('effectiveModelsContainer');
      if (!container) return;

      const models = Array.isArray(effectiveModelPool)
        ? effectiveModelPool.map((m) => String(m)).filter((m) => m.trim())
        : [];

      container.textContent = '';

      if (models.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '暂无可用模型（可能全部被禁用）';
        container.appendChild(empty);
        return;
      }

      for (const m of models) {
        const item = document.createElement('div');
        item.className = 'list-item';

        const info = document.createElement('div');
        info.className = 'item-info';

        const primary = document.createElement('div');
        primary.className = 'item-primary';

        const modelSpan = document.createElement('span');
        modelSpan.className = 'key-text';
        modelSpan.textContent = m;

        primary.appendChild(modelSpan);
        info.appendChild(primary);
        item.appendChild(info);

        container.appendChild(item);
      }
    }

    function renderDisabledModels() {
      const container = document.getElementById('disabledModelsContainer');
      const hint = document.getElementById('disabledModelsHint');
      const clearBtn = document.getElementById('clearDisabledModelsBtn');
      if (!container || !hint) return;

      const map = (disabledModelsState && typeof disabledModelsState === 'object')
        ? disabledModelsState
        : {};

      const entries = [];
      for (const [model, entry] of Object.entries(map)) {
        const name = String(model || '').trim();
        if (!name) continue;
        const disabledAt = entry && entry.disabledAt ? Number(entry.disabledAt) : 0;
        const reason = entry && entry.reason ? String(entry.reason) : '';
        entries.push({ model: name, disabledAt, reason });
      }

      entries.sort((a, b) => (b.disabledAt - a.disabledAt) || a.model.localeCompare(b.model));

      const days = disabledModelRetentionMs
        ? Math.max(1, Math.round(Number(disabledModelRetentionMs) / (24 * 60 * 60 * 1000)))
        : 0;

      hint.textContent = entries.length === 0
        ? ('暂无禁用模型' + (days ? ('；保留期：' + String(days) + ' 天') : ''))
        : ('已禁用：' + String(entries.length) + (days ? ('；保留期：' + String(days) + ' 天') : ''));

      if (clearBtn) {
        clearBtn.disabled = entries.length === 0;
      }

      container.textContent = '';

      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '没有禁用模型';
        container.appendChild(empty);
        return;
      }

      for (const e of entries) {
        const item = document.createElement('div');
        item.className = 'list-item';

        const info = document.createElement('div');
        info.className = 'item-info';

        const primary = document.createElement('div');
        primary.className = 'item-primary';

        const modelSpan = document.createElement('span');
        modelSpan.className = 'key-text';
        modelSpan.textContent = e.model;

        const badge = document.createElement('span');
        badge.className = 'status-badge status-invalid';
        badge.textContent = 'disabled';

        primary.appendChild(modelSpan);
        primary.appendChild(badge);

        const secondary = document.createElement('div');
        secondary.className = 'item-secondary';
        const timeText = e.disabledAt ? formatTimestamp(e.disabledAt) : '';
        secondary.textContent = (timeText ? ('禁用时间：' + timeText) : '');
        if (e.reason) {
          secondary.textContent = secondary.textContent
            ? (secondary.textContent + ' · ' + '原因：' + e.reason)
            : ('原因：' + e.reason);
        }

        info.appendChild(primary);
        if (secondary.textContent) info.appendChild(secondary);
        item.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn btn-success';
        restoreBtn.textContent = '恢复';
        restoreBtn.addEventListener('click', () => restoreDisabledModel(e.model));

        actions.appendChild(restoreBtn);
        item.appendChild(actions);

        container.appendChild(item);
      }
    }

    async function restoreDisabledModel(model) {
      const name = String(model || '').trim();
      if (!name) return;

      try {
        const res = await fetch('/api/models/disabled/' + encodeURIComponent(name), {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '恢复失败', 'error');
          return;
        }
        showNotification('已恢复：' + name);
        loadModels();
      } catch (e) {
        showNotification('恢复失败: ' + formatClientError(e), 'error');
      }
    }

    async function clearDisabledModels() {
      if (!confirm('清空禁用列表？之后被禁用的模型将允许再次参与轮询。')) return;

      const btn = document.getElementById('clearDisabledModelsBtn');
      setButtonLoading(btn, true, '清空中...');

      try {
        const res = await fetch('/api/models/disabled', {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '清空失败', 'error');
          return;
        }
        showNotification('已清空禁用列表');
        loadModels();
      } catch (e) {
        showNotification('清空失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    function renderModelCatalog() {
      const container = document.getElementById('modelCatalogContainer');
      const hint = document.getElementById('modelCatalogHint');
      if (!container || !hint) return;

      const pool = Array.isArray(currentModelPool) ? currentModelPool.map(m => String(m)) : [];
      const poolSet = new Set(pool);

      const disabled = (disabledModelsState && typeof disabledModelsState === 'object')
        ? disabledModelsState
        : {};

      const catalogModels = (modelCatalogState && Array.isArray(modelCatalogState.models))
        ? modelCatalogState.models.map(m => String(m))
        : [];
      const catalogSet = new Set(catalogModels);

      const searchEl = document.getElementById('modelCatalogSearch');
      const q = (searchEl && 'value' in searchEl ? String(searchEl.value || '') : '').trim().toLowerCase();

      container.textContent = '';

      if (!modelCatalogState) {
        hint.textContent = '未加载模型目录';
      } else {
        const fetchedAt = modelCatalogState.fetchedAt ? formatTimestamp(modelCatalogState.fetchedAt) : '';
        const stale = modelCatalogState.stale ? '；目录可能过时' : '';
        const lastError = modelCatalogState.lastError ? ('；上次错误：' + modelCatalogState.lastError) : '';
        hint.textContent = '目录模型数：' + String(catalogModels.length) + (fetchedAt ? ('；更新时间：' + fetchedAt) : '') + stale + lastError;
      }

      function addCheckboxRow(model, badgeText) {
        const name = String(model || '').trim();
        if (!name) return;
        if (q && !name.toLowerCase().includes(q)) return;

        const item = document.createElement('div');
        item.className = 'list-item';

        const info = document.createElement('div');
        info.className = 'item-info';

        const primary = document.createElement('div');
        primary.className = 'item-primary';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'model-pool-checkbox';
        checkbox.dataset.model = name;
        checkbox.checked = poolSet.has(name);
        checkbox.style.marginRight = '8px';

        const modelSpan = document.createElement('span');
        modelSpan.className = 'key-text';
        modelSpan.textContent = name;

        primary.appendChild(checkbox);
        primary.appendChild(modelSpan);

        const disabledEntry = disabled && typeof disabled === 'object' ? disabled[name] : null;
        if (disabledEntry) {
          const badge = document.createElement('span');
          badge.className = 'status-badge status-invalid';
          badge.textContent = '已禁用';
          const reason = disabledEntry.reason ? String(disabledEntry.reason) : '';
          const disabledAt = disabledEntry.disabledAt ? formatTimestamp(disabledEntry.disabledAt) : '';
          badge.title = (disabledAt ? ('禁用时间：' + disabledAt + '；') : '') + (reason ? ('原因：' + reason) : '');
          primary.appendChild(badge);
        }

        if (badgeText) {
          const badge = document.createElement('span');
          badge.className = 'status-badge status-inactive';
          badge.textContent = badgeText;
          primary.appendChild(badge);
        }

        info.appendChild(primary);
        item.appendChild(info);
        container.appendChild(item);
      }

      const extras = pool.filter((m) => !catalogSet.has(m));
      if (extras.length > 0) {
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = '自定义/不在目录';
        container.appendChild(title);
        for (const m of extras) addCheckboxRow(m, '自定义');

        const divider = document.createElement('div');
        divider.className = 'divider';
        container.appendChild(divider);
      }

      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = '目录模型';
      container.appendChild(title);

      if (catalogModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '目录为空（可能是网络问题或上游变更）';
        container.appendChild(empty);
        return;
      }

      for (const m of catalogModels) {
        addCheckboxRow(m, '');
      }
    }

    async function loadModelCatalog() {
      try {
        const res = await fetch('/api/models/catalog', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载模型目录失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        modelCatalogState = data;
        renderModelCatalog();
      } catch (e) {
        showNotification('加载模型目录失败: ' + formatClientError(e), 'error');
      }
    }

    async function refreshModelCatalog() {
      const btn = document.getElementById('refreshModelCatalogBtn');
      setButtonLoading(btn, true, '刷新中...');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/models/catalog/refresh', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('刷新失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        modelCatalogState = data;
        showNotification('目录已刷新');
        renderModelCatalog();
      } catch (e) {
        showNotification('刷新失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function saveModelPoolFromSelection() {
      const btn = document.getElementById('saveModelPoolBtn');
      setButtonLoading(btn, true, '保存中...');

      try {
        const nodes = document.querySelectorAll('.model-pool-checkbox');
        const models = [];
        const seen = new Set();

        for (const el of nodes) {
          if (!el || el.type !== 'checkbox') continue;
          if (!el.checked) continue;
          const m = String(el.dataset.model || '').trim();
          if (!m || seen.has(m)) continue;
          seen.add(m);
          models.push(m);
        }

        if (models.length === 0) {
          showNotification('模型池不能为空', 'error');
          return;
        }

        const res = await fetch('/api/models', {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ models }),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '保存失败', 'error');
          return;
        }

        showNotification('模型池已保存');
        loadModels();
      } catch (e) {
        showNotification('保存失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function loadModels() {
      try {
        const res = await fetch('/api/models', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        currentModelPool = Array.isArray(data.models) ? data.models.map(m => String(m)) : [];
        effectiveModelPool = Array.isArray(data.effectiveModels) ? data.effectiveModels.map(m => String(m)) : [];
        disabledModelsState = (data.disabledModels && typeof data.disabledModels === 'object') ? data.disabledModels : {};
        disabledModelRetentionMs = Number(data.disabledModelRetentionMs || 0);

        const container = document.getElementById('modelsContainer');
        if (data.models?.length > 0) {
          container.textContent = '';

          for (const m of data.models) {
            const name = String(m ?? '').trim();
            if (!name) continue;

            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const modelSpan = document.createElement('span');
            modelSpan.className = 'key-text';
            modelSpan.textContent = name;

            primary.appendChild(modelSpan);

            const disabledEntry = disabledModelsState && typeof disabledModelsState === 'object'
              ? disabledModelsState[name]
              : null;
            if (disabledEntry) {
              const badge = document.createElement('span');
              badge.className = 'status-badge status-invalid';
              badge.textContent = 'disabled';
              const reason = disabledEntry.reason ? String(disabledEntry.reason) : '';
              const disabledAt = disabledEntry.disabledAt ? formatTimestamp(disabledEntry.disabledAt) : '';
              badge.title = (disabledAt ? ('禁用时间：' + disabledAt + '；') : '') + (reason ? ('原因：' + reason) : '');
              primary.appendChild(badge);
            }

            info.appendChild(primary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const encodedName = encodeURIComponent(name);

            const testBtn = document.createElement('button');
            testBtn.className = 'btn btn-success';
            testBtn.textContent = '测试';
            testBtn.addEventListener('click', () => testModel(encodedName, testBtn));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', () => deleteModel(encodedName));

            actions.appendChild(testBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '模型池为空（将使用默认模型）';
          container.appendChild(empty);
        }

        renderEffectiveModels();
        renderDisabledModels();
        renderModelCatalog();
      } catch (e) {
        showNotification('加载失败: ' + formatClientError(e), 'error');
      }
    }

    async function addModel() {
      const model = document.getElementById('newModel').value.trim();
      if (!model) { showNotification('请输入模型名称', 'error'); return; }
      try {
        const res = await fetch('/api/models', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '添加失败', 'error');
          return;
        }
        showNotification('模型已添加');
        document.getElementById('newModel').value = '';
        loadModels();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function deleteModel(name) {
      if (!confirm('删除此模型？')) return;
      try {
        const res = await fetch('/api/models/' + name, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '删除失败', 'error');
          return;
        }
        showNotification('模型已删除');
        loadModels();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function testModel(name, btn) {
      setButtonLoading(btn, true, '测试中...');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/models/' + name + '/test', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('模型测试失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        const ok = Boolean(data.success);
        const detail = data.error || data.status || (res.ok ? '' : ('HTTP ' + res.status));
        showNotification(ok ? '模型可用' : ('模型不可用: ' + detail), ok ? 'success' : 'error');
      } catch (e) {
        showNotification('模型测试失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    const modelSearch = document.getElementById('modelCatalogSearch');
    if (modelSearch) {
      modelSearch.addEventListener('input', () => renderModelCatalog());
    }

    checkAuth();
  </script>
</body>
</html>`,
      {
        headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/html" },
      },
    );
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
