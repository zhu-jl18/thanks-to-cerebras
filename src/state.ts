import type {
  ApiKey,
  ModelCatalog,
  ProxyAuthKey,
  ProxyConfig,
} from "./types.ts";
import { DEFAULT_KV_FLUSH_INTERVAL_MS } from "./constants.ts";
import { logger } from "./logger.ts";

let _isDenoDeployment: boolean | undefined;
export function isDenoDeployment(): boolean {
  if (_isDenoDeployment === undefined) {
    _isDenoDeployment = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
  }
  return _isDenoDeployment;
}

export class AppState {
  kv!: Deno.Kv;

  cachedConfig: ProxyConfig | null = null;
  dirtyConfig = false;

  cachedKeysById = new Map<string, ApiKey>();
  cachedActiveKeyIds: string[] = [];
  cachedCursor = 0;
  keyCooldownUntil = new Map<string, number>();
  dirtyKeyIds = new Set<string>();

  flushInProgress = false;
  kvFlushTimerId: ReturnType<typeof setInterval> | null = null;
  kvFlushIntervalMsEffective = DEFAULT_KV_FLUSH_INTERVAL_MS;
  pendingTotalRequests = 0;

  cachedModelPool: string[] = [];
  modelCursor = 0;
  cachedModelCatalog: ModelCatalog | null = null;
  modelCatalogFetchInFlight: Promise<ModelCatalog> | null = null;
  upstreamCircuitFailureCount = 0;
  upstreamCircuitOpenedUntil = 0;
  upstreamCircuitHalfOpenInFlight = false;

  cachedProxyKeys: Map<string, ProxyAuthKey> | null = null;
  proxyKeyCacheRefreshInFlight: Promise<Map<string, ProxyAuthKey>> | null =
    null;
  proxyKeyCacheLastLoadedAt = 0;
  dirtyProxyKeyIds = new Set<string>();
  authCacheRevision = 0;
  authCacheRevisionLastCheckedAt = 0;
  authCacheRevisionRefreshInFlight: Promise<void> | null = null;

  apiKeyCacheRevision = 0;
  apiKeyCacheRevisionLastCheckedAt = 0;
  apiKeyCacheRevisionRefreshInFlight: Promise<void> | null = null;
  apiKeyEmptyPoolRefreshLastAttemptAt = 0;

  addPendingTotalRequests(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.pendingTotalRequests += Math.trunc(delta);
  }

  subtractPendingTotalRequests(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.pendingTotalRequests = Math.max(
      0,
      this.pendingTotalRequests - Math.trunc(delta),
    );
  }

  async initKv(): Promise<void> {
    assertKvSupported();
    if (isDenoDeployment()) {
      this.kv = await Deno.openKv();
      return;
    }
    const kvDir = Deno.env.get("KV_PATH") ||
      `${import.meta.dirname}/.deno-kv-local`;
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
        logger.error("kv_local_directory_create_failed", { kvDir }, e);
        throw e;
      }
    }
    this.kv = await Deno.openKv(`${kvDir}/kv.sqlite3`);
  }
}

function assertKvSupported(): void {
  const openKv = (Deno as unknown as { openKv?: unknown }).openKv;
  if (typeof openKv === "function") return;

  const message = [
    "[KV] Deno.openKv 不可用：需要启用 Deno KV（unstable）。",
    "",
    "可选修复：",
    '- 本地运行：使用 `--unstable-kv`，或在 `deno.json` 里添加 `"unstable": ["kv"]`',
    "- Deno Deploy：请使用 Git 部署并确保仓库根目录的 `deno.json` 被加载（本仓库已内置），必要时在 Build Config 启用 KV/unstable",
    "",
    "当前运行时给的报错：`Deno.openKv is not a function`",
  ].join("\n");

  throw new Error(message);
}

export const state = new AppState();
