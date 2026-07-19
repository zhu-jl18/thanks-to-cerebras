function replaceExactlyOnce(
  source: string,
  before: string,
  after: string,
  label: string,
): string {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected one match, found ${count}`);
  }
  return source.replace(before, after);
}

async function rewrite(
  path: string,
  transform: (source: string) => string,
): Promise<void> {
  const source = await Deno.readTextFile(path);
  await Deno.writeTextFile(path, transform(source));
}

await rewrite("src/secrets.ts", (source) => {
  source = replaceExactlyOnce(
    source,
    `function secretMaterial(): Uint8Array {
  const secret = Deno.env.get("KEY_ENCRYPTION_SECRET")?.trim();
  if (!secret) {
    throw new Error("KEY_ENCRYPTION_SECRET 未配置，禁止写入或读取密钥");
  }
  return encoder.encode(secret);
}`,
    `function encryptionSecret(): string {
  const secret = Deno.env.get("KEY_ENCRYPTION_SECRET")?.trim();
  if (!secret) {
    throw new Error("KEY_ENCRYPTION_SECRET 未配置，禁止写入或读取密钥");
  }
  return secret;
}

function secretMaterial(): Uint8Array {
  return encoder.encode(encryptionSecret());
}`,
    "root secret accessor",
  );

  source = replaceExactlyOnce(
    source,
    `async function deriveApiKeyFingerprintKey(): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    bytesSource(secretMaterial()),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const keyMaterial = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytesSource(API_KEY_FINGERPRINT_SALT),
      info: bytesSource(API_KEY_FINGERPRINT_INFO),
    },
    rootKey,
    SHA256_BYTES * 8,
  );
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}`,
    `interface ApiKeyFingerprintKeyCache {
  secret: string;
  keyPromise: Promise<CryptoKey>;
}

let apiKeyFingerprintKeyCache: ApiKeyFingerprintKeyCache | null = null;

async function importApiKeyFingerprintKey(secret: string): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    bytesSource(encoder.encode(secret)),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const keyMaterial = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytesSource(API_KEY_FINGERPRINT_SALT),
      info: bytesSource(API_KEY_FINGERPRINT_INFO),
    },
    rootKey,
    SHA256_BYTES * 8,
  );
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function deriveApiKeyFingerprintKey(): Promise<CryptoKey> {
  const secret = encryptionSecret();
  if (apiKeyFingerprintKeyCache?.secret === secret) {
    return apiKeyFingerprintKeyCache.keyPromise;
  }

  const keyPromise = importApiKeyFingerprintKey(secret).catch((error) => {
    if (apiKeyFingerprintKeyCache?.keyPromise === keyPromise) {
      apiKeyFingerprintKeyCache = null;
    }
    throw error;
  });
  apiKeyFingerprintKeyCache = { secret, keyPromise };
  return keyPromise;
}`,
    "fingerprint key cache",
  );
  return source;
});

await rewrite("src/kv/api-key-store-schema.ts", (source) => {
  source = replaceExactlyOnce(
    source,
    `import { API_KEY_PREFIX, API_KEY_UNIQUE_PREFIX } from "../constants.ts";`,
    `import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  API_KEY_UNIQUE_PREFIX,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";`,
    "schema constants import",
  );
  source = replaceExactlyOnce(
    source,
    `} from "../secrets.ts";

export type ApiKeyMetadata`,
    `} from "../secrets.ts";
import { waitForKvAtomicRetry } from "./atomic-retry.ts";

export type ApiKeyMetadata`,
    "schema retry import",
  );

  source = replaceExactlyOnce(
    source,
    `export async function loadVerifiedApiKeys(kv: Deno.Kv): Promise<ApiKey[]> {
  const recordsByFingerprint = new Map<string, PersistedApiKey>();
  const recordIter = kv.list<unknown>({ prefix: API_KEY_PREFIX });
  for await (const entry of recordIter) {
    const persisted = assertApiKeyRecordEntry(entry);
    if (recordsByFingerprint.has(persisted.fingerprint)) {
      invariant("multiple records own the same fingerprint");
    }
    recordsByFingerprint.set(persisted.fingerprint, persisted);
  }

  const claimsByFingerprint = new Map<string, string>();
  const claimIter = kv.list<string>({ prefix: API_KEY_UNIQUE_PREFIX });
  for await (const entry of claimIter) {
    const fingerprint = assertClaimFingerprint(entry);
    if (claimsByFingerprint.has(fingerprint)) {
      invariant("duplicate unique-claim key");
    }
    claimsByFingerprint.set(fingerprint, entry.value);
  }

  if (recordsByFingerprint.size !== claimsByFingerprint.size) {
    invariant("record and unique-claim counts differ");
  }
  for (const [fingerprint, persisted] of recordsByFingerprint) {
    if (claimsByFingerprint.get(fingerprint) !== persisted.id) {
      invariant("record is not owned by its unique claim");
    }
  }
  for (const [fingerprint, id] of claimsByFingerprint) {
    if (recordsByFingerprint.get(fingerprint)?.id !== id) {
      invariant("unique claim is dangling or points at the wrong record");
    }
  }

  const keys: ApiKey[] = [];
  for (const persisted of recordsByFingerprint.values()) {
    keys.push(await hydrateApiKeyRecord(persisted));
  }
  return keys;
}

export async function loadVerifiedApiKey(
  kv: Deno.Kv,
  id: string,
): Promise<ApiKey | null> {
  const recordEntry = await kv.get<unknown>(apiKeyRecordKey(id));
  if (recordEntry.value === null) return null;

  const persisted = assertApiKeyRecordEntry(recordEntry, id);
  const claimEntry = await kv.get<string>(
    apiKeyUniqueClaimKey(persisted.fingerprint),
  );
  if (claimEntry.value !== id) {
    invariant("record is not owned by its unique claim");
  }
  return hydrateApiKeyRecord(persisted);
}`,
    `interface ApiKeyStoreSnapshot {
  recordsByFingerprint: Map<string, PersistedApiKey>;
  claimsByFingerprint: Map<string, string>;
}

async function scanApiKeyStore(kv: Deno.Kv): Promise<ApiKeyStoreSnapshot> {
  const recordsByFingerprint = new Map<string, PersistedApiKey>();
  const recordIter = kv.list<unknown>({ prefix: API_KEY_PREFIX });
  for await (const entry of recordIter) {
    const persisted = assertApiKeyRecordEntry(entry);
    if (recordsByFingerprint.has(persisted.fingerprint)) {
      invariant("multiple records own the same fingerprint");
    }
    recordsByFingerprint.set(persisted.fingerprint, persisted);
  }

  const claimsByFingerprint = new Map<string, string>();
  const claimIter = kv.list<string>({ prefix: API_KEY_UNIQUE_PREFIX });
  for await (const entry of claimIter) {
    const fingerprint = assertClaimFingerprint(entry);
    if (claimsByFingerprint.has(fingerprint)) {
      invariant("duplicate unique-claim key");
    }
    claimsByFingerprint.set(fingerprint, entry.value);
  }
  return { recordsByFingerprint, claimsByFingerprint };
}

function verifyApiKeyStoreSnapshot(
  snapshot: ApiKeyStoreSnapshot,
): PersistedApiKey[] {
  const { recordsByFingerprint, claimsByFingerprint } = snapshot;
  if (recordsByFingerprint.size !== claimsByFingerprint.size) {
    invariant("record and unique-claim counts differ");
  }
  for (const [fingerprint, persisted] of recordsByFingerprint) {
    if (claimsByFingerprint.get(fingerprint) !== persisted.id) {
      invariant("record is not owned by its unique claim");
    }
  }
  for (const [fingerprint, id] of claimsByFingerprint) {
    if (recordsByFingerprint.get(fingerprint)?.id !== id) {
      invariant("unique claim is dangling or points at the wrong record");
    }
  }
  return Array.from(recordsByFingerprint.values());
}

export async function loadVerifiedApiKeys(kv: Deno.Kv): Promise<ApiKey[]> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const revisionBefore = await kv.get<number>(API_KEY_CACHE_REVISION_KEY);
    const snapshot = await scanApiKeyStore(kv);
    const revisionAfter = await kv.get<number>(API_KEY_CACHE_REVISION_KEY);

    if (revisionBefore.versionstamp !== revisionAfter.versionstamp) {
      await waitForKvAtomicRetry(attempt);
      continue;
    }

    const persistedKeys = verifyApiKeyStoreSnapshot(snapshot);
    return Promise.all(persistedKeys.map(hydrateApiKeyRecord));
  }
  throw new Error("API key store changed during every full-read attempt");
}`,
    "stable verified store scan",
  );
  return source;
});

await rewrite("src/kv/api-key-store.ts", (source) => {
  source = replaceExactlyOnce(
    source,
    `  hydrateApiKeyRecord,
  loadVerifiedApiKey,
  loadVerifiedApiKeys,`,
    `  hydrateApiKeyRecord,
  loadVerifiedApiKeys,`,
    "remove single-load import",
  );
  source = replaceExactlyOnce(
    source,
    `export { apiKeyUniqueClaimKey } from "./api-key-store-schema.ts";`,
    `export { ApiKeyStoreInvariantError, apiKeyUniqueClaimKey };`,
    "store exports",
  );
  source = replaceExactlyOnce(
    source,
    `function corruptResult(
  error: unknown,
): { ok: false; code: "store-corrupt" } | never {
  if (error instanceof ApiKeyStoreInvariantError) {
    return { ok: false, code: "store-corrupt" };
  }
  throw error;
}
`,
    `function corruptResult(
  error: unknown,
): { ok: false; code: "store-corrupt" } | never {
  if (error instanceof ApiKeyStoreInvariantError) {
    return { ok: false, code: "store-corrupt" };
  }
  throw error;
}

type ObservedRecordState = "missing" | "changed" | "unchanged";

async function observeRecordState(
  kv: Deno.Kv,
  recordKey: Deno.KvKey,
  observed: Deno.KvEntryMaybe<unknown>,
): Promise<ObservedRecordState> {
  const latest = await kv.get<unknown>(recordKey);
  if (latest.value === null) return "missing";
  return latest.versionstamp === observed.versionstamp
    ? "unchanged"
    : "changed";
}
`,
    "record race helper",
  );
  source = replaceExactlyOnce(
    source,
    `  get(id: string): Promise<ApiKey | null> {
    return loadVerifiedApiKey(this.kv, id);
  }`,
    `  async get(id: string): Promise<ApiKey | null> {
    const recordKey = apiKeyRecordKey(id);
    for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
      const recordEntry = await this.kv.get<unknown>(recordKey);
      if (recordEntry.value === null) return null;

      const persisted = assertApiKeyRecordEntry(recordEntry, id);
      const claimEntry = await this.kv.get<string>(
        apiKeyUniqueClaimKey(persisted.fingerprint),
      );
      if (claimEntry.value !== id) {
        const recordState = await observeRecordState(
          this.kv,
          recordKey,
          recordEntry,
        );
        if (recordState === "missing") return null;
        if (recordState === "changed") {
          await waitForKvAtomicRetry(attempt);
          continue;
        }
        throw new ApiKeyStoreInvariantError(
          "record is not owned by its unique claim",
        );
      }
      return hydrateApiKeyRecord(persisted);
    }
    throw new Error("API key read conflict: reached retry limit");
  }`,
    "race-safe get",
  );
  source = replaceExactlyOnce(
    source,
    `      if (claimEntry.value !== id) {
        return { ok: false, code: "store-corrupt" };
      }

      const revision = getNextRevisionValue(revisionEntry);`,
    `      if (claimEntry.value !== id) {
        const recordState = await observeRecordState(
          this.kv,
          recordKey,
          recordEntry,
        );
        if (recordState === "missing") {
          return { ok: false, code: "not-found" };
        }
        if (recordState === "changed") {
          await waitForKvAtomicRetry(attempt);
          continue;
        }
        return { ok: false, code: "store-corrupt" };
      }

      const revision = getNextRevisionValue(revisionEntry);`,
    "race-safe delete claim check",
  );

  source = replaceExactlyOnce(
    source,
    `      let persisted: PersistedApiKey;
      let current: ApiKey;
      try {
        persisted = assertApiKeyRecordEntry(recordEntry, id);
        current = await hydrateApiKeyRecord(persisted);
      } catch (error) {
        return corruptResult(error);
      }

      const [claimEntry, revisionEntry] = await Promise.all([
        this.kv.get<string>(apiKeyUniqueClaimKey(persisted.fingerprint)),
        this.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
      ]);
      if (claimEntry.value !== id) {
        return { ok: false, code: "store-corrupt" };
      }

      const metadata = mutate(current);`,
    `      let persisted: PersistedApiKey;
      try {
        persisted = assertApiKeyRecordEntry(recordEntry, id);
      } catch (error) {
        return corruptResult(error);
      }

      const [claimEntry, revisionEntry] = await Promise.all([
        this.kv.get<string>(apiKeyUniqueClaimKey(persisted.fingerprint)),
        this.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
      ]);
      if (claimEntry.value !== id) {
        const recordState = await observeRecordState(
          this.kv,
          recordKey,
          recordEntry,
        );
        if (recordState === "missing") {
          return { ok: false, code: "not-found" };
        }
        if (recordState === "changed") {
          await waitForKvAtomicRetry(attempt);
          continue;
        }
        return { ok: false, code: "store-corrupt" };
      }

      let current: ApiKey;
      try {
        current = await hydrateApiKeyRecord(persisted);
      } catch (error) {
        return corruptResult(error);
      }
      const metadata = mutate(current);`,
    "race-safe update claim check",
  );

  source = replaceExactlyOnce(
    source,
    `    if (claimEntry.value !== id) {
      throw new ApiKeyStoreInvariantError(
        "record is not owned by its unique claim",
      );
    }
    const result = await this.kv.atomic()`,
    `    if (claimEntry.value !== id) {
      const recordState = await observeRecordState(this.kv, recordKey, entry);
      if (recordState === "missing") return "missing";
      if (recordState === "changed") return "conflict";
      throw new ApiKeyStoreInvariantError(
        "record is not owned by its unique claim",
      );
    }
    const result = await this.kv.atomic()`,
    "race-safe usage merge",
  );
  return source;
});

await rewrite("src/kv/api-keys.ts", (source) =>
  replaceExactlyOnce(
    source,
    `  const local = state.cachedKeysById.get(id);
  const result = await store().update(id, (current) => ({
    status: updates.status ??
      (local?.status === "invalid" ? "invalid" : current.status),
    useCount: updates.useCount ??
      Math.max(local?.useCount ?? 0, current.useCount),
    lastUsed: updates.lastUsed ??
      (Math.max(local?.lastUsed ?? 0, current.lastUsed ?? 0) || undefined),
  }));`,
    `  const result = await store().update(id, (current) => {
    const local = state.cachedKeysById.get(id);
    return {
      status: updates.status ??
        (local?.status === "invalid" ? "invalid" : current.status),
      useCount: updates.useCount ??
        Math.max(local?.useCount ?? 0, current.useCount),
      lastUsed: updates.lastUsed ??
        (Math.max(local?.lastUsed ?? 0, current.lastUsed ?? 0) || undefined),
    };
  });`,
    "fresh cache read per update attempt",
  )
);

await rewrite("src/services/proxy.ts", (source) =>
  replaceExactlyOnce(
    source,
    `  if (!apiKeyData) {
    await kvMergeAllApiKeysIntoCache();
    apiKeyData = getNextApiKeyFast(Date.now());
  }`,
    `  if (!apiKeyData) {
    try {
      await kvMergeAllApiKeysIntoCache();
    } catch (error) {
      // A forced refresh must preserve the last verified cache just like the
      // revision-driven refresh path. Persistent invariant failures are logged
      // but must not escape through the proxy request path.
      logger.warn(
        "api_key_cache_refresh_failed",
        { ...context, phase: "empty_pool_merge" },
        error,
      );
    }
    apiKeyData = getNextApiKeyFast(Date.now());
  }`,
    "best-effort empty-pool refresh",
  )
);

await rewrite("src/kv/flush.ts", (source) => {
  source = replaceExactlyOnce(
    source,
    `import { kvGetAllKeys, kvMergeApiKeyUsage } from "./api-keys.ts";`,
    `import { ApiKeyStoreInvariantError } from "./api-key-store.ts";
import { kvGetAllKeys, kvMergeApiKeyUsage } from "./api-keys.ts";`,
    "flush invariant import",
  );
  source = replaceExactlyOnce(
    source,
    `  const result = await kvMergeApiKeyUsage(
    id,
    keyEntry.useCount,
    keyEntry.lastUsed,
  );
  if (result === "conflict") state.dirtyKeyIds.add(id);`,
    `  try {
    const result = await kvMergeApiKeyUsage(
      id,
      keyEntry.useCount,
      keyEntry.lastUsed,
    );
    if (result === "conflict") state.dirtyKeyIds.add(id);
  } catch (error) {
    if (!(error instanceof ApiKeyStoreInvariantError)) throw error;

    // Repeating the same stats write cannot repair a broken record/claim
    // invariant. Isolate the bad key so unrelated stats and config still flush.
    metrics.inc("api_key_usage_flush_total", "store_corrupt");
    logger.error("api_key_usage_flush_store_corrupt", { keyId: id }, error);
  }`,
    "isolate corrupt usage flush",
  );
  source = replaceExactlyOnce(
    source,
    `export async function bootstrapCache(): Promise<void> {
  state.cachedConfig = await kvGetConfig();
  const keys = await kvGetAllKeys();`,
    `export async function bootstrapCache(): Promise<void> {
  const [config, apiKeyRevision] = await Promise.all([
    kvGetConfig(),
    getApiKeyCacheRevision(),
  ]);
  state.cachedConfig = config;
  const keys = await kvGetAllKeys();`,
    "bootstrap revision before store read",
  );
  source = replaceExactlyOnce(
    source,
    `  state.authCacheRevision = await getAuthCacheRevision();
  state.authCacheRevisionLastCheckedAt = Date.now();
  state.apiKeyCacheRevision = await getApiKeyCacheRevision();
  state.apiKeyCacheRevisionLastCheckedAt = Date.now();`,
    `  state.authCacheRevision = await getAuthCacheRevision();
  state.authCacheRevisionLastCheckedAt = Date.now();
  // Keep the revision at or behind the loaded snapshot. A mutation after the
  // initial read is observed by the normal refresh path instead of being hidden
  // behind a newer revision than the cache actually contains.
  state.apiKeyCacheRevision = apiKeyRevision;
  state.apiKeyCacheRevisionLastCheckedAt = Date.now();`,
    "bootstrap exact cache revision",
  );
  return source;
});

await rewrite("src/__tests__/api-key-store_test.ts", (source) => {
  source = replaceExactlyOnce(
    source,
    `import { assertEquals, assertRejects } from "@std/assert";
import { API_KEY_PREFIX, API_KEY_UNIQUE_PREFIX } from "../constants.ts";
import { fingerprintApiKey, isApiKeyFingerprint } from "../secrets.ts";`,
    `import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  API_KEY_UNIQUE_PREFIX,
} from "../constants.ts";
import {
  encryptApiKey,
  fingerprintApiKey,
  isApiKeyFingerprint,
} from "../secrets.ts";`,
    "store test imports",
  );
  source = replaceExactlyOnce(
    source,
    `import { apiKeyUniqueClaimKey } from "../kv/api-key-store.ts";
import { setLogSinkForTests } from "../logger.ts";`,
    `import { apiKeyUniqueClaimKey } from "../kv/api-key-store.ts";
import { kvGetConfig } from "../kv/config.ts";
import { bootstrapCache, flushDirtyToKv } from "../kv/flush.ts";
import { getNextRevisionValue } from "../kv/revisions.ts";
import { setLogSinkForTests } from "../logger.ts";
import { metrics } from "../metrics.ts";`,
    "store test KV imports",
  );
  source = replaceExactlyOnce(
    source,
    `async function countPrefix(prefix: Deno.KvKey): Promise<number> {
  let count = 0;
  for await (const entry of state.kv.list({ prefix })) {
    void entry;
    count++;
  }
  return count;
}
`,
    `async function countPrefix(prefix: Deno.KvKey): Promise<number> {
  let count = 0;
  for await (const entry of state.kv.list({ prefix })) {
    void entry;
    count++;
  }
  return count;
}

function sameKey(left: Deno.KvKey, right: readonly unknown[]): boolean {
  return left.length === right.length &&
    left.every((part, index) => part === right[index]);
}

function installKvGetInterceptor(
  beforeGet: (kv: Deno.Kv, key: Deno.KvKey) => Promise<void>,
): { restore: () => void } {
  const original = state.kv;
  state.kv = new Proxy(original, {
    get(target, property) {
      if (property === "get") {
        return async (key: Deno.KvKey, ...rest: unknown[]) => {
          await beforeGet(target, key);
          return (target.get as unknown as (
            key: Deno.KvKey,
            ...rest: unknown[]
          ) => Promise<unknown>).call(target, key, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;

  return {
    restore: () => {
      state.kv = original;
    },
  };
}

function installConcurrentDeleteOnClaimRead(
  id: string,
  claimKey: Deno.KvKey,
): { restore: () => void; raced: () => boolean } {
  const recordKey = [...API_KEY_PREFIX, id];
  let raced = false;
  const interceptor = installKvGetInterceptor(async (kv, key) => {
    if (raced || !sameKey(key, claimKey)) return;

    raced = true;
    const revisionEntry = await kv.get<number>(API_KEY_CACHE_REVISION_KEY);
    const revision = getNextRevisionValue(revisionEntry);
    await kv.atomic()
      .delete(recordKey)
      .delete(claimKey)
      .set(API_KEY_CACHE_REVISION_KEY, revision)
      .commit();
  });
  return { ...interceptor, raced: () => raced };
}
`,
    "store test race helpers",
  );
  source = replaceExactlyOnce(
    source,
    `  assertEquals(first, second);
  assertEquals(first !== differentValue, true);
  assertEquals(first !== differentDeployment, true);
  assertEquals(isApiKeyFingerprint(first), true);
  assertEquals(first.includes("sk-fingerprint-value"), false);`,
    `  assertEquals(first, second);
  assertNotEquals(first, differentValue);
  assertNotEquals(first, differentDeployment);
  assert(isApiKeyFingerprint(first));
  assertEquals(first.includes("sk-fingerprint-value"), false);`,
    "clear fingerprint assertions",
  );

  source = replaceExactlyOnce(
    source,
    `Deno.test(
  "kvAddKey: atomically creates one record and one unique claim",`,
    `Deno.test(
  "kvGetAllKeys: retries a full scan when its revision changes",
  async () => {
    const kv = await setupKv();
    const id = crypto.randomUUID();
    const plaintext = "sk-created-during-scan";
    const [fingerprint, encryptedKey] = await Promise.all([
      fingerprintApiKey(plaintext),
      encryptApiKey(plaintext),
    ]);
    let revisionReads = 0;
    let raced = false;
    const interceptor = installKvGetInterceptor(async (store, key) => {
      if (!sameKey(key, API_KEY_CACHE_REVISION_KEY)) return;

      revisionReads++;
      if (revisionReads !== 2 || raced) return;

      raced = true;
      const revisionEntry = await store.get<number>(
        API_KEY_CACHE_REVISION_KEY,
      );
      const revision = getNextRevisionValue(revisionEntry);
      await store.atomic()
        .set([...API_KEY_PREFIX, id], {
          id,
          fingerprint,
          encryptedKey,
          useCount: 0,
          status: "active",
          createdAt: 1,
        })
        .set(apiKeyUniqueClaimKey(fingerprint), id)
        .set(API_KEY_CACHE_REVISION_KEY, revision)
        .commit();
    });

    try {
      const keys = await kvGetAllKeys();
      assert(raced);
      assertEquals(keys.map((key) => key.id), [id]);
    } finally {
      interceptor.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvAddKey: atomically creates one record and one unique claim",`,
    "stable scan regression",
  );

  source = replaceExactlyOnce(
    source,
    `Deno.test(
  "kvGetAllKeys: rejects the old record schema instead of silently degrading",`,
    `Deno.test(
  "kvDeleteKey: concurrent valid deletion is not reported as corruption",
  async () => {
    const kv = await setupKv();
    const id = await requireCreated("sk-concurrent-delete");
    const record = await kv.get<Record<string, unknown>>([
      ...API_KEY_PREFIX,
      id,
    ]);
    const fingerprint = record.value?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("fingerprint missing");
    const race = installConcurrentDeleteOnClaimRead(
      id,
      apiKeyUniqueClaimKey(fingerprint),
    );

    try {
      assertEquals(await kvDeleteKey(id), {
        ok: false,
        code: "not-found",
      });
      assert(race.raced());
    } finally {
      race.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvUpdateKey: concurrent valid deletion is not reported as corruption",
  async () => {
    const kv = await setupKv();
    const id = await requireCreated("sk-concurrent-update-delete");
    const record = await kv.get<Record<string, unknown>>([
      ...API_KEY_PREFIX,
      id,
    ]);
    const fingerprint = record.value?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("fingerprint missing");
    const race = installConcurrentDeleteOnClaimRead(
      id,
      apiKeyUniqueClaimKey(fingerprint),
    );

    try {
      assertEquals(await kvUpdateKey(id, { status: "inactive" }), {
        updated: false,
      });
      assert(race.raced());
      assertEquals(state.cachedKeysById.has(id), false);
    } finally {
      race.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvGetAllKeys: rejects the old record schema instead of silently degrading",`,
    "concurrent delete regressions",
  );

  source += `

Deno.test(
  "flushDirtyToKv: one corrupt API-key record does not block config flush",
  async () => {
    const kv = await setupKv();
    await bootstrapCache();
    try {
      const id = await requireCreated("sk-corrupt-usage-flush");
      const record = await kv.get<Record<string, unknown>>([
        ...API_KEY_PREFIX,
        id,
      ]);
      const fingerprint = record.value?.fingerprint;
      if (typeof fingerprint !== "string") {
        throw new Error("fingerprint missing");
      }
      await kv.set(apiKeyUniqueClaimKey(fingerprint), "wrong-owner");

      const cached = state.cachedKeysById.get(id);
      if (!cached) throw new Error("cached key missing");
      cached.useCount = 7;
      state.dirtyKeyIds.add(id);
      state.addPendingTotalRequests(3);
      state.dirtyConfig = true;

      await flushDirtyToKv();

      assertEquals(state.pendingTotalRequests, 0);
      assertEquals((await kvGetConfig()).totalRequests, 3);
      assertEquals(state.dirtyKeyIds.has(id), false);
      assertEquals(
        metrics.snapshot().api_key_usage_flush_total?.store_corrupt,
        1,
      );
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
`;
  return source;
});

await rewrite("src/__tests__/api-key-kv_test.ts", (source) =>
  replaceExactlyOnce(
    source,
    `Deno.test(
  "kvUpdateKey: returns updated false and cleans cache when record is missing",`,
    `Deno.test(
  "kvUpdateKey: retries against the latest cache object",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-retry-fresh-cache");
    const originalAtomic = kv.atomic.bind(kv);
    let failedOnce = false;

    kv.atomic = () => {
      const operation = originalAtomic();
      const originalCommit = operation.commit.bind(operation);
      operation.commit = async () => {
        if (!failedOnce) {
          failedOnce = true;
          const cached = state.cachedKeysById.get(id);
          if (!cached) throw new Error("cached key missing");
          state.cachedKeysById.set(id, {
            ...cached,
            useCount: 9,
            lastUsed: 1_234,
          });
          return { ok: false } as unknown as Deno.KvCommitResult;
        }
        return originalCommit();
      };
      return operation;
    };

    try {
      assertEquals(await kvUpdateKey(id, { status: "inactive" }), {
        updated: true,
      });
      const persisted = await kv.get<Record<string, unknown>>([
        ...API_KEY_PREFIX,
        id,
      ]);
      assertEquals(persisted.value?.useCount, 9);
      assertEquals(persisted.value?.lastUsed, 1_234);
    } finally {
      kv.atomic = originalAtomic;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvUpdateKey: returns updated false and cleans cache when record is missing",`,
    "fresh cache retry regression",
  )
);

await rewrite("src/__tests__/api-key-cache-refresh_test.ts", (source) => {
  source = replaceExactlyOnce(
    source,
    `import { createApiKeyStore } from "../kv/api-key-store.ts";`,
    `import {
  apiKeyUniqueClaimKey,
  createApiKeyStore,
} from "../kv/api-key-store.ts";`,
    "cache test store imports",
  );
  source = replaceExactlyOnce(
    source,
    `import { setLogSinkForTests } from "../logger.ts";`,
    `import { setLogSinkForTests } from "../logger.ts";
import { fingerprintApiKey } from "../secrets.ts";`,
    "cache test fingerprint import",
  );
  source = replaceExactlyOnce(
    source,
    `Deno.test("refresh recovers after a transient record-list failure", async () => {`,
    `Deno.test(
  "proxy empty-pool refresh contains strict store verification failures",
  async () => {
    const kv = await setupKv();
    const handler = createHandler(createRouter());
    state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
    const fingerprint = await fingerprintApiKey("sk-dangling-empty-pool");
    await kv.set(apiKeyUniqueClaimKey(fingerprint), "missing-owner");
    const logs = captureLogs();

    try {
      const response = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );
      const body = await response.json();

      assertEquals(response.status, 500);
      assertEquals(body.error, "没有可用的 API 密钥");
      const warnings = logs.records.filter((item) =>
        item.level === "warn" &&
        item.record.event === "api_key_cache_refresh_failed" &&
        item.record.phase === "empty_pool_merge"
      );
      assertEquals(warnings.length, 1);
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test("refresh recovers after a transient record-list failure", async () => {`,
    "empty-pool fallback regression",
  );
  return source;
});

await rewrite("docs/API.md", (source) =>
  source.endsWith("\n") ? source : `${source}\n`
);
