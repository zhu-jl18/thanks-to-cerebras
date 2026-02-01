import type {
  ApiKey,
  ModelCatalog,
  ProxyAuthKey,
  ProxyConfig,
} from "./types.ts";
import {
  API_KEY_PREFIX,
  CEREBRAS_PUBLIC_MODELS_URL,
  CONFIG_KEY,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  DEFAULT_MODEL_POOL,
  KV_ATOMIC_MAX_RETRIES,
  MAX_PROXY_KEYS,
  MODEL_CATALOG_FETCH_TIMEOUT_MS,
  MODEL_CATALOG_KEY,
  MODEL_CATALOG_TTL_MS,
  PROXY_KEY_PREFIX,
} from "./constants.ts";
import { generateProxyKey } from "./keys.ts";
import {
  fetchWithTimeout,
  generateId,
  normalizeKvFlushIntervalMs,
} from "./utils.ts";
import { rebuildActiveKeyIds } from "./api-keys.ts";
import { normalizeModelPool, rebuildModelPoolCache } from "./models.ts";
import {
  cachedConfig,
  cachedKeysById,
  cachedModelPool,
  cachedProxyKeys,
  dirtyConfig,
  dirtyKeyIds,
  dirtyProxyKeyIds,
  flushInProgress,
  keyCooldownUntil,
  kv,
  kvFlushIntervalMsEffective,
  kvFlushTimerId,
  modelCatalogFetchInFlight,
  setCachedConfig,
  setCachedKeysById,
  setCachedModelCatalog,
  setCachedProxyKeys,
  setDirtyConfig,
  setFlushInProgress,
  setKvFlushIntervalMsEffective,
  setKvFlushTimerId,
  setModelCatalogFetchInFlight,
} from "./state.ts";

// KV flush interval management
export function resolveKvFlushIntervalMs(config: ProxyConfig | null): number {
  const ms = config?.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS;
  return normalizeKvFlushIntervalMs(ms);
}

export function applyKvFlushInterval(config: ProxyConfig | null): void {
  setKvFlushIntervalMsEffective(resolveKvFlushIntervalMs(config));

  if (kvFlushTimerId !== null) {
    clearInterval(kvFlushTimerId);
  }
  setKvFlushTimerId(setInterval(flushDirtyToKv, kvFlushIntervalMsEffective));
}

// Flush dirty data to KV
export async function flushDirtyToKv(): Promise<void> {
  // Clean expired cooldown entries to prevent memory leaks
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

  setFlushInProgress(true);
  const keyIds = Array.from(dirtyKeyIds);
  dirtyKeyIds.clear();
  const proxyKeyIds = Array.from(dirtyProxyKeyIds);
  dirtyProxyKeyIds.clear();
  const flushConfig = dirtyConfig;
  setDirtyConfig(false);

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
    setDirtyConfig(dirtyConfig || flushConfig);
    console.error(`[KV] flush failed:`, error);
  } finally {
    setFlushInProgress(false);
  }
}

// Bootstrap cache from KV
export async function bootstrapCache(): Promise<void> {
  setCachedConfig(await kvGetConfig());
  const keys = await kvGetAllKeys();
  setCachedKeysById(new Map(keys.map((k) => [k.id, k])));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();

  const proxyKeys = await kvGetAllProxyKeys();
  setCachedProxyKeys(new Map(proxyKeys.map((k) => [k.id, k])));
}

// Config operations
export async function kvEnsureConfigEntry(): Promise<
  Deno.KvEntry<ProxyConfig>
> {
  let entry = await kv.get<ProxyConfig>(CONFIG_KEY);

  if (!entry.value) {
    const defaultConfig: ProxyConfig = {
      modelPool: [...DEFAULT_MODEL_POOL],
      currentModelIndex: 0,
      totalRequests: 0,
      kvFlushIntervalMs: DEFAULT_KV_FLUSH_INTERVAL_MS,
      schemaVersion: "5.0",
    };
    await kv.set(CONFIG_KEY, defaultConfig);
    entry = await kv.get<ProxyConfig>(CONFIG_KEY);
  }

  if (!entry.value) {
    throw new Error("KV 配置初始化失败");
  }

  const raw = entry.value as unknown as Record<string, unknown>;

  const modelPool = Array.isArray(raw.modelPool)
    ? normalizeModelPool(raw.modelPool)
    : [...DEFAULT_MODEL_POOL];

  const currentModelIndex = typeof raw.currentModelIndex === "number" &&
      Number.isFinite(raw.currentModelIndex) &&
      raw.currentModelIndex >= 0
    ? Math.trunc(raw.currentModelIndex)
    : 0;

  const totalRequests = typeof raw.totalRequests === "number" &&
      Number.isFinite(raw.totalRequests) &&
      raw.totalRequests >= 0
    ? Math.trunc(raw.totalRequests)
    : 0;

  const kvFlushIntervalMs = typeof raw.kvFlushIntervalMs === "number" &&
      Number.isFinite(raw.kvFlushIntervalMs)
    ? raw.kvFlushIntervalMs
    : DEFAULT_KV_FLUSH_INTERVAL_MS;

  const needsMigration = raw.schemaVersion !== "5.0" || "disabledModels" in raw;

  if (needsMigration) {
    const nextConfig: ProxyConfig = {
      modelPool,
      currentModelIndex,
      totalRequests,
      kvFlushIntervalMs,
      schemaVersion: "5.0",
    };
    await kv.set(CONFIG_KEY, nextConfig);
    entry = await kv.get<ProxyConfig>(CONFIG_KEY);
  }

  if (!entry.value) {
    throw new Error("KV 配置初始化失败");
  }

  return entry as Deno.KvEntry<ProxyConfig>;
}

export async function kvGetConfig(): Promise<ProxyConfig> {
  const entry = await kvEnsureConfigEntry();
  return entry.value;
}

export async function kvUpdateConfig(
  updater: (config: ProxyConfig) => ProxyConfig | Promise<ProxyConfig>,
): Promise<ProxyConfig> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await kvEnsureConfigEntry();
    const nextConfig = await updater(entry.value);
    if (nextConfig === entry.value) {
      setCachedConfig(entry.value);
      return entry.value;
    }
    const result = await kv
      .atomic()
      .check(entry)
      .set(CONFIG_KEY, nextConfig)
      .commit();
    if (result.ok) {
      setCachedConfig(nextConfig);
      return nextConfig;
    }
  }
  throw new Error("配置更新失败：达到最大重试次数");
}

// Model catalog operations
export function isModelCatalogFresh(
  catalog: ModelCatalog,
  now: number,
): boolean {
  return (
    now >= catalog.fetchedAt && now - catalog.fetchedAt < MODEL_CATALOG_TTL_MS
  );
}

export async function kvGetModelCatalog(): Promise<ModelCatalog | null> {
  const entry = await kv.get<ModelCatalog>(MODEL_CATALOG_KEY);
  return entry.value ?? null;
}

export async function refreshModelCatalog(): Promise<ModelCatalog> {
  if (modelCatalogFetchInFlight) {
    return await modelCatalogFetchInFlight;
  }

  const promise = (async () => {
    const response = await fetchWithTimeout(
      CEREBRAS_PUBLIC_MODELS_URL,
      {
        method: "GET",
        headers: { Accept: "application/json" },
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

    setCachedModelCatalog(catalog);

    try {
      await kv.set(MODEL_CATALOG_KEY, catalog);
    } catch (error) {
      console.error(`[KV] model catalog save failed:`, error);
    }

    return catalog;
  })().finally(() => {
    setModelCatalogFetchInFlight(null);
  });

  setModelCatalogFetchInFlight(promise);
  return await promise;
}

// Remove model from pool
export async function removeModelFromPool(
  model: string,
  reason: string,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;

  const existed = cachedModelPool.includes(trimmed);

  await kvUpdateConfig((config) => {
    const pool = normalizeModelPool(config.modelPool);
    const nextPool = pool.filter((m) => m !== trimmed);

    if (nextPool.length === pool.length) {
      return config;
    }

    return {
      ...config,
      modelPool: nextPool,
      currentModelIndex: 0,
      schemaVersion: "5.0",
    };
  });

  rebuildModelPoolCache();

  if (existed) {
    console.warn(`[MODEL] removed (${reason}): ${trimmed}`);
  }
}

// API key operations
export async function kvGetAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const iter = kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ApiKey);
  }
  return keys;
}

export async function kvAddKey(
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

export async function kvDeleteKey(
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

export async function kvUpdateKey(
  id: string,
  updates: Partial<ApiKey>,
): Promise<void> {
  const key = [...API_KEY_PREFIX, id];
  const existing = cachedKeysById.get(id) ?? (await kv.get<ApiKey>(key)).value;
  if (!existing) return;
  const updated = { ...existing, ...updates };
  await kv.set(key, updated);
  cachedKeysById.set(id, updated);
  rebuildActiveKeyIds();
}

// Proxy key operations
export async function kvGetAllProxyKeys(): Promise<ProxyAuthKey[]> {
  const keys: ProxyAuthKey[] = [];
  const iter = kv.list({ prefix: PROXY_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ProxyAuthKey);
  }
  return keys;
}

export async function kvAddProxyKey(
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

export async function kvDeleteProxyKey(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const key = [...PROXY_KEY_PREFIX, id];
  const result = await kv.get(key);
  if (!result.value) {
    return { success: false, error: "密钥不存在" };
  }

  await kv.delete(key);
  cachedProxyKeys.delete(id);
  dirtyProxyKeyIds.delete(id);
  return { success: true };
}
