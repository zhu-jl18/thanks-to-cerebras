import type {
  ApiKey,
  ModelCatalog,
  ProxyAuthKey,
  ProxyConfig,
} from "./types.ts";
import { DEFAULT_KV_FLUSH_INTERVAL_MS } from "./constants.ts";

// Deno KV instance
export const isDenoDeployment = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
export const kv = await (() => {
  if (isDenoDeployment) return Deno.openKv();
  const kvDir = `${import.meta.dirname}/.deno-kv-local`;
  try {
    Deno.mkdirSync(kvDir, { recursive: true });
  } catch (e) {
    if (
      e instanceof Deno.errors.AlreadyExists ||
      (typeof e === "object" && e !== null && "name" in e &&
        (e as { name?: string }).name === "AlreadyExists")
    ) {
      // Directory already exists
    } else {
      console.error("[KV] 无法创建本地 KV 目录：", e);
      throw e;
    }
  }
  return Deno.openKv(`${kvDir}/kv.sqlite3`);
})();

// Config cache
export let cachedConfig: ProxyConfig | null = null;
export function setCachedConfig(config: ProxyConfig | null): void {
  cachedConfig = config;
}

// API key caches
export let cachedKeysById = new Map<string, ApiKey>();
export function setCachedKeysById(keys: Map<string, ApiKey>): void {
  cachedKeysById = keys;
}

export let cachedActiveKeyIds: string[] = [];
export function setCachedActiveKeyIds(ids: string[]): void {
  cachedActiveKeyIds = ids;
}

export let cachedCursor = 0;
export function setCachedCursor(cursor: number): void {
  cachedCursor = cursor;
}

export const keyCooldownUntil = new Map<string, number>();
export const dirtyKeyIds = new Set<string>();

export let dirtyConfig = false;
export function setDirtyConfig(dirty: boolean): void {
  dirtyConfig = dirty;
}

export let flushInProgress = false;
export function setFlushInProgress(inProgress: boolean): void {
  flushInProgress = inProgress;
}

// Model pool cache
export let cachedModelPool: string[] = [];
export function setCachedModelPool(pool: string[]): void {
  cachedModelPool = pool;
}

export let modelCursor = 0;
export function setModelCursor(cursor: number): void {
  modelCursor = cursor;
}

// Model catalog cache
export let cachedModelCatalog: ModelCatalog | null = null;
export function setCachedModelCatalog(catalog: ModelCatalog | null): void {
  cachedModelCatalog = catalog;
}

export let modelCatalogFetchInFlight: Promise<ModelCatalog> | null = null;
export function setModelCatalogFetchInFlight(
  promise: Promise<ModelCatalog> | null,
): void {
  modelCatalogFetchInFlight = promise;
}

// Proxy auth key cache
export let cachedProxyKeys = new Map<string, ProxyAuthKey>();
export function setCachedProxyKeys(keys: Map<string, ProxyAuthKey>): void {
  cachedProxyKeys = keys;
}

export const dirtyProxyKeyIds = new Set<string>();

// KV flush timer
export let kvFlushTimerId: number | null = null;
export function setKvFlushTimerId(id: number | null): void {
  kvFlushTimerId = id;
}

export let kvFlushIntervalMsEffective = DEFAULT_KV_FLUSH_INTERVAL_MS;
export function setKvFlushIntervalMsEffective(ms: number): void {
  kvFlushIntervalMsEffective = ms;
}
