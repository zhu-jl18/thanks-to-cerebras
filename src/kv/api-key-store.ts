import type { ApiKey } from "../types.ts";
import {
  assertPersistedApiKey,
  createPersistedApiKey,
  type PersistedApiKey,
} from "../api-key-record.ts";
import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  API_KEY_UNIQUE_PREFIX,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import {
  decryptApiKey,
  encryptApiKey,
  fingerprintApiKey,
  isApiKeyFingerprint,
} from "../secrets.ts";
import { generateId } from "../utils.ts";
import { waitForKvAtomicRetry } from "./atomic-retry.ts";
import { getNextRevisionValue } from "./revisions.ts";

export type ApiKeyMetadata = Pick<
  ApiKey,
  "status" | "useCount" | "lastUsed"
>;

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

export class ApiKeyStoreInvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`API key store invariant violated: ${message}`, options);
    this.name = "ApiKeyStoreInvariantError";
  }
}

export function apiKeyRecordKey(id: string): Deno.KvKey {
  return [...API_KEY_PREFIX, id];
}

export function apiKeyUniqueClaimKey(fingerprint: string): Deno.KvKey {
  return [...API_KEY_UNIQUE_PREFIX, fingerprint];
}

function invariant(message: string, cause?: unknown): never {
  throw new ApiKeyStoreInvariantError(message, { cause });
}

function assertRecordEntry(
  entry: Deno.KvEntry<unknown> | Deno.KvEntryMaybe<unknown>,
  expectedId?: string,
): PersistedApiKey {
  let persisted: PersistedApiKey;
  try {
    persisted = assertPersistedApiKey(entry.value);
  } catch (error) {
    invariant("invalid persisted record", error);
  }

  const keyId = entry.key[API_KEY_PREFIX.length];
  if (
    entry.key.length !== API_KEY_PREFIX.length + 1 ||
    typeof keyId !== "string" || keyId.length === 0
  ) {
    invariant("invalid record key tuple");
  }
  if (persisted.id !== keyId || (expectedId !== undefined && keyId !== expectedId)) {
    invariant("record id does not match its key tuple");
  }
  return persisted;
}

function assertClaimFingerprint(entry: Deno.KvEntry<string>): string {
  const fingerprint = entry.key[API_KEY_UNIQUE_PREFIX.length];
  if (
    entry.key.length !== API_KEY_UNIQUE_PREFIX.length + 1 ||
    typeof fingerprint !== "string" ||
    !isApiKeyFingerprint(fingerprint)
  ) {
    invariant("invalid unique-claim key tuple");
  }
  if (typeof entry.value !== "string" || entry.value.length === 0) {
    invariant("invalid unique-claim owner id");
  }
  return fingerprint;
}

async function hydrateAndVerify(persisted: PersistedApiKey): Promise<ApiKey> {
  const plaintext = await decryptApiKey(persisted.encryptedKey);
  const actualFingerprint = await fingerprintApiKey(plaintext);
  if (actualFingerprint !== persisted.fingerprint) {
    invariant("record fingerprint does not match its ciphertext");
  }
  const { fingerprint: _fingerprint, ...apiKey } = persisted;
  return { ...apiKey, key: plaintext };
}

function assertMetadata(metadata: ApiKeyMetadata): void {
  if (
    metadata.status !== "active" && metadata.status !== "inactive" &&
    metadata.status !== "invalid"
  ) {
    invariant("metadata mutation produced an invalid status");
  }
  if (
    typeof metadata.useCount !== "number" ||
    !Number.isFinite(metadata.useCount) || metadata.useCount < 0
  ) {
    invariant("metadata mutation produced an invalid useCount");
  }
  if (
    metadata.lastUsed !== undefined &&
    (typeof metadata.lastUsed !== "number" ||
      !Number.isFinite(metadata.lastUsed) || metadata.lastUsed < 0)
  ) {
    invariant("metadata mutation produced an invalid lastUsed");
  }
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

class DenoKvApiKeyStore implements ApiKeyStore {
  constructor(private readonly kv: Deno.Kv) {}

  async list(): Promise<ApiKey[]> {
    const recordsByFingerprint = new Map<string, PersistedApiKey>();
    const recordIter = this.kv.list<unknown>({ prefix: API_KEY_PREFIX });
    for await (const entry of recordIter) {
      const persisted = assertRecordEntry(entry);
      if (recordsByFingerprint.has(persisted.fingerprint)) {
        invariant("multiple records own the same fingerprint");
      }
      recordsByFingerprint.set(persisted.fingerprint, persisted);
    }

    const claimsByFingerprint = new Map<string, string>();
    const claimIter = this.kv.list<string>({ prefix: API_KEY_UNIQUE_PREFIX });
    for await (const entry of claimIter) {
      const fingerprint = assertClaimFingerprint(entry);
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
      keys.push(await hydrateAndVerify(persisted));
    }
    return keys;
  }

  async get(id: string): Promise<ApiKey | null> {
    const recordEntry = await this.kv.get<unknown>(apiKeyRecordKey(id));
    if (recordEntry.value === null) return null;

    const persisted = assertRecordEntry(recordEntry, id);
    const claimEntry = await this.kv.get<string>(
      apiKeyUniqueClaimKey(persisted.fingerprint),
    );
    if (claimEntry.value !== id) {
      invariant("record is not owned by its unique claim");
    }
    return hydrateAndVerify(persisted);
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
      const persisted = createPersistedApiKey(key, fingerprint);
      const revision = getNextRevisionValue(revisionEntry);
      const result = await this.kv.atomic()
        .check(recordEntry)
        .check(claimEntry)
        .check(revisionEntry)
        .set(recordKey, persisted)
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
        persisted = assertRecordEntry(recordEntry, id);
      } catch (error) {
        if (error instanceof ApiKeyStoreInvariantError) {
          return { ok: false, code: "store-corrupt" };
        }
        throw error;
      }
      const claimKey = apiKeyUniqueClaimKey(persisted.fingerprint);
      const [claimEntry, revisionEntry] = await Promise.all([
        this.kv.get<string>(claimKey),
        this.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
      ]);
      if (claimEntry.value !== id) {
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
      let current: ApiKey;
      try {
        persisted = assertRecordEntry(recordEntry, id);
        current = await hydrateAndVerify(persisted);
      } catch (error) {
        if (error instanceof ApiKeyStoreInvariantError || error instanceof DOMException) {
          return { ok: false, code: "store-corrupt" };
        }
        throw error;
      }

      const claimEntry = await this.kv.get<string>(
        apiKeyUniqueClaimKey(persisted.fingerprint),
      );
      if (claimEntry.value !== id) {
        return { ok: false, code: "store-corrupt" };
      }
      const revisionEntry = await this.kv.get<number>(API_KEY_CACHE_REVISION_KEY);
      const metadata = mutate(current);
      assertMetadata(metadata);
      const updatedPersisted: PersistedApiKey = {
        ...persisted,
        status: metadata.status,
        useCount: metadata.useCount,
        ...(metadata.lastUsed === undefined
          ? { lastUsed: undefined }
          : { lastUsed: metadata.lastUsed }),
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

    const persisted = assertRecordEntry(entry, id);
    const mergedLastUsed = Math.max(persisted.lastUsed ?? 0, lastUsed ?? 0) ||
      undefined;
    const result = await this.kv.atomic()
      .check(entry)
      .set(recordKey, {
        ...persisted,
        useCount: Math.max(persisted.useCount, useCount),
        lastUsed: mergedLastUsed,
      })
      .commit();
    return result.ok ? "updated" : "conflict";
  }
}

export function createApiKeyStore(kv: Deno.Kv): ApiKeyStore {
  return new DenoKvApiKeyStore(kv);
}