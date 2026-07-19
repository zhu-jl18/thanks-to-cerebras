import type { ApiKey } from "../types.ts";
import {
  createPersistedApiKey,
  type PersistedApiKey,
} from "../api-key-record.ts";
import {
  API_KEY_CACHE_REVISION_KEY,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import { encryptApiKey, fingerprintApiKey } from "../secrets.ts";
import { generateId } from "../utils.ts";
import { waitForKvAtomicRetry } from "./atomic-retry.ts";
import { getNextRevisionValue } from "./revisions.ts";
import {
  type ApiKeyMetadata,
  apiKeyRecordKey,
  ApiKeyStoreInvariantError,
  apiKeyUniqueClaimKey,
  assertApiKeyMetadata,
  assertApiKeyRecordEntry,
  hydrateApiKeyRecord,
  loadVerifiedApiKeys,
} from "./api-key-store-schema.ts";

export { ApiKeyStoreInvariantError, apiKeyUniqueClaimKey };

export type ApiKeyStoreCreateResult =
  | { ok: true; key: ApiKey; revision: number }
  | { ok: false; code: "duplicate" | "conflict" };

export type ApiKeyStoreDeleteResult =
  | { ok: true; revision: number }
  | {
    ok: false;
    code: "not-found" | "conflict" | "store-corrupt";
  };

export type ApiKeyStoreUpdateResult =
  | { ok: true; key: ApiKey; revision: number }
  | {
    ok: false;
    code: "not-found" | "conflict" | "store-corrupt";
  };

export type ApiKeyUsageMergeResult = "updated" | "missing" | "conflict";

export interface ApiKeyStore {
  list(): Promise<ApiKey[]>;
  get(id: string): Promise<ApiKey | null>;
  create(plaintext: string): Promise<ApiKeyStoreCreateResult>;
  delete(id: string): Promise<ApiKeyStoreDeleteResult>;
  update(
    id: string,
    mutate: (current: Readonly<ApiKey>) => ApiKeyMetadata,
  ): Promise<ApiKeyStoreUpdateResult>;
  mergeUsage(
    id: string,
    useCount: number,
    lastUsed?: number,
  ): Promise<ApiKeyUsageMergeResult>;
}

let lastApiKeyCreatedAtMs = 0;
function nextApiKeyCreatedAt(): number {
  const now = Date.now();
  const createdAt = now <= lastApiKeyCreatedAtMs
    ? lastApiKeyCreatedAtMs + 1
    : now;
  lastApiKeyCreatedAtMs = createdAt;
  return createdAt;
}

function corruptResult(
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

class DenoKvApiKeyStore implements ApiKeyStore {
  constructor(private readonly kv: Deno.Kv) {}

  list(): Promise<ApiKey[]> {
    return loadVerifiedApiKeys(this.kv);
  }

  async get(id: string): Promise<ApiKey | null> {
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
  }

  async create(plaintext: string): Promise<ApiKeyStoreCreateResult> {
    const [fingerprint, encryptedKey] = await Promise.all([
      fingerprintApiKey(plaintext),
      encryptApiKey(plaintext),
    ]);
    const claimKey = apiKeyUniqueClaimKey(fingerprint);
    const createdAt = nextApiKeyCreatedAt();
    let id = generateId();

    for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
      const recordKey = apiKeyRecordKey(id);
      const [recordEntry, claimEntry, revisionEntry] = await Promise.all([
        this.kv.get(recordKey),
        this.kv.get<string>(claimKey),
        this.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
      ]);
      if (claimEntry.value !== null) {
        return { ok: false, code: "duplicate" };
      }
      if (recordEntry.value !== null) {
        id = generateId();
        continue;
      }

      const key: ApiKey = {
        id,
        encryptedKey,
        key: plaintext,
        useCount: 0,
        status: "active",
        createdAt,
      };
      const revision = getNextRevisionValue(revisionEntry);
      const result = await this.kv.atomic()
        .check(recordEntry)
        .check(claimEntry)
        .check(revisionEntry)
        .set(recordKey, createPersistedApiKey(key, fingerprint))
        .set(claimKey, id)
        .set(API_KEY_CACHE_REVISION_KEY, revision)
        .commit();
      if (result.ok) return { ok: true, key, revision };
      await waitForKvAtomicRetry(attempt);
    }
    return { ok: false, code: "conflict" };
  }

  async delete(id: string): Promise<ApiKeyStoreDeleteResult> {
    const recordKey = apiKeyRecordKey(id);
    for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
      const recordEntry = await this.kv.get<unknown>(recordKey);
      if (recordEntry.value === null) return { ok: false, code: "not-found" };

      let persisted: PersistedApiKey;
      try {
        persisted = assertApiKeyRecordEntry(recordEntry, id);
      } catch (error) {
        return corruptResult(error);
      }
      const claimKey = apiKeyUniqueClaimKey(persisted.fingerprint);
      const [claimEntry, revisionEntry] = await Promise.all([
        this.kv.get<string>(claimKey),
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

      const revision = getNextRevisionValue(revisionEntry);
      const result = await this.kv.atomic()
        .check(recordEntry)
        .check(claimEntry)
        .check(revisionEntry)
        .delete(recordKey)
        .delete(claimKey)
        .set(API_KEY_CACHE_REVISION_KEY, revision)
        .commit();
      if (result.ok) return { ok: true, revision };
      await waitForKvAtomicRetry(attempt);
    }
    return { ok: false, code: "conflict" };
  }

  async update(
    id: string,
    mutate: (current: Readonly<ApiKey>) => ApiKeyMetadata,
  ): Promise<ApiKeyStoreUpdateResult> {
    const recordKey = apiKeyRecordKey(id);
    for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
      const recordEntry = await this.kv.get<unknown>(recordKey);
      if (recordEntry.value === null) return { ok: false, code: "not-found" };

      let persisted: PersistedApiKey;
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
      const metadata = mutate(current);
      assertApiKeyMetadata(metadata);
      const updatedPersisted: PersistedApiKey = {
        ...persisted,
        ...metadata,
      };
      const revision = getNextRevisionValue(revisionEntry);
      const result = await this.kv.atomic()
        .check(recordEntry)
        .check(claimEntry)
        .check(revisionEntry)
        .set(recordKey, updatedPersisted)
        .set(API_KEY_CACHE_REVISION_KEY, revision)
        .commit();
      if (result.ok) {
        return {
          ok: true,
          key: { ...current, ...metadata },
          revision,
        };
      }
      await waitForKvAtomicRetry(attempt);
    }
    return { ok: false, code: "conflict" };
  }

  async mergeUsage(
    id: string,
    useCount: number,
    lastUsed?: number,
  ): Promise<ApiKeyUsageMergeResult> {
    const recordKey = apiKeyRecordKey(id);
    const entry = await this.kv.get<unknown>(recordKey);
    if (entry.value === null) return "missing";

    const persisted = assertApiKeyRecordEntry(entry, id);
    const claimEntry = await this.kv.get<string>(
      apiKeyUniqueClaimKey(persisted.fingerprint),
    );
    if (claimEntry.value !== id) {
      const recordState = await observeRecordState(this.kv, recordKey, entry);
      if (recordState === "missing") return "missing";
      if (recordState === "changed") return "conflict";
      throw new ApiKeyStoreInvariantError(
        "record is not owned by its unique claim",
      );
    }
    const result = await this.kv.atomic()
      .check(entry)
      .check(claimEntry)
      .set(recordKey, {
        ...persisted,
        useCount: Math.max(persisted.useCount, useCount),
        lastUsed: Math.max(persisted.lastUsed ?? 0, lastUsed ?? 0) || undefined,
      })
      .commit();
    return result.ok ? "updated" : "conflict";
  }
}

export function createApiKeyStore(kv: Deno.Kv): ApiKeyStore {
  return new DenoKvApiKeyStore(kv);
}
