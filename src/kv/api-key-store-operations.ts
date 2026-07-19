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
} from "./api-key-store-schema.ts";

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

type ObservedRecordState = "missing" | "changed" | "unchanged";

function corruptResult(
  error: unknown,
): { ok: false; code: "store-corrupt" } | never {
  if (error instanceof ApiKeyStoreInvariantError) {
    return { ok: false, code: "store-corrupt" };
  }
  throw error;
}

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

let lastApiKeyCreatedAtMs = 0;
function nextApiKeyCreatedAt(): number {
  const now = Date.now();
  const createdAt = now <= lastApiKeyCreatedAtMs
    ? lastApiKeyCreatedAtMs + 1
    : now;
  lastApiKeyCreatedAtMs = createdAt;
  return createdAt;
}

export async function getApiKey(
  kv: Deno.Kv,
  id: string,
): Promise<ApiKey | null> {
  const recordKey = apiKeyRecordKey(id);
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const recordEntry = await kv.get<unknown>(recordKey);
    if (recordEntry.value === null) return null;

    const persisted = assertApiKeyRecordEntry(recordEntry, id);
    const claimEntry = await kv.get<string>(
      apiKeyUniqueClaimKey(persisted.fingerprint),
    );
    if (claimEntry.value === id) return hydrateApiKeyRecord(persisted);

    const recordState = await observeRecordState(kv, recordKey, recordEntry);
    if (recordState === "missing") return null;
    if (recordState === "unchanged") {
      throw new ApiKeyStoreInvariantError(
        "record is not owned by its unique claim",
      );
    }
    await waitForKvAtomicRetry(attempt);
  }
  throw new Error("API key read conflict: reached retry limit");
}

export async function createApiKey(
  kv: Deno.Kv,
  plaintext: string,
): Promise<ApiKeyStoreCreateResult> {
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
      kv.get(recordKey),
      kv.get<string>(claimKey),
      kv.get<number>(API_KEY_CACHE_REVISION_KEY),
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
    const result = await kv.atomic()
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

export async function deleteApiKey(
  kv: Deno.Kv,
  id: string,
): Promise<ApiKeyStoreDeleteResult> {
  const recordKey = apiKeyRecordKey(id);
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const recordEntry = await kv.get<unknown>(recordKey);
    if (recordEntry.value === null) return { ok: false, code: "not-found" };

    let persisted: PersistedApiKey;
    try {
      persisted = assertApiKeyRecordEntry(recordEntry, id);
    } catch (error) {
      return corruptResult(error);
    }
    const claimKey = apiKeyUniqueClaimKey(persisted.fingerprint);
    const [claimEntry, revisionEntry] = await Promise.all([
      kv.get<string>(claimKey),
      kv.get<number>(API_KEY_CACHE_REVISION_KEY),
    ]);
    if (claimEntry.value !== id) {
      const recordState = await observeRecordState(kv, recordKey, recordEntry);
      if (recordState === "missing") return { ok: false, code: "not-found" };
      if (recordState === "changed") {
        await waitForKvAtomicRetry(attempt);
        continue;
      }
      return { ok: false, code: "store-corrupt" };
    }

    const revision = getNextRevisionValue(revisionEntry);
    const result = await kv.atomic()
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

export async function updateApiKey(
  kv: Deno.Kv,
  id: string,
  mutate: (current: Readonly<ApiKey>) => ApiKeyMetadata,
): Promise<ApiKeyStoreUpdateResult> {
  const recordKey = apiKeyRecordKey(id);
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const recordEntry = await kv.get<unknown>(recordKey);
    if (recordEntry.value === null) return { ok: false, code: "not-found" };

    let persisted: PersistedApiKey;
    try {
      persisted = assertApiKeyRecordEntry(recordEntry, id);
    } catch (error) {
      return corruptResult(error);
    }

    const [claimEntry, revisionEntry] = await Promise.all([
      kv.get<string>(apiKeyUniqueClaimKey(persisted.fingerprint)),
      kv.get<number>(API_KEY_CACHE_REVISION_KEY),
    ]);
    if (claimEntry.value !== id) {
      const recordState = await observeRecordState(kv, recordKey, recordEntry);
      if (recordState === "missing") return { ok: false, code: "not-found" };
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
    const revision = getNextRevisionValue(revisionEntry);
    const result = await kv.atomic()
      .check(recordEntry)
      .check(claimEntry)
      .check(revisionEntry)
      .set(recordKey, { ...persisted, ...metadata })
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

export async function mergeApiKeyUsage(
  kv: Deno.Kv,
  id: string,
  useCount: number,
  lastUsed?: number,
): Promise<ApiKeyUsageMergeResult> {
  const recordKey = apiKeyRecordKey(id);
  const entry = await kv.get<unknown>(recordKey);
  if (entry.value === null) return "missing";

  const persisted = assertApiKeyRecordEntry(entry, id);
  const claimEntry = await kv.get<string>(
    apiKeyUniqueClaimKey(persisted.fingerprint),
  );
  if (claimEntry.value !== id) {
    const recordState = await observeRecordState(kv, recordKey, entry);
    if (recordState === "missing") return "missing";
    if (recordState === "changed") return "conflict";
    throw new ApiKeyStoreInvariantError(
      "record is not owned by its unique claim",
    );
  }

  const mergedLastUsed = Math.max(persisted.lastUsed ?? 0, lastUsed ?? 0) ||
    undefined;
  const result = await kv.atomic()
    .check(entry)
    .check(claimEntry)
    .set(recordKey, {
      ...persisted,
      useCount: Math.max(persisted.useCount, useCount),
      lastUsed: mergedLastUsed,
    })
    .commit();
  return result.ok ? "updated" : "conflict";
}
