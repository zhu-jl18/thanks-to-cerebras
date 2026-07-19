import type { ApiKey } from "../types.ts";
import {
  assertCurrentApiKey,
  type PersistedApiKey,
  toPersistedApiKey,
} from "../api-key-record.ts";
import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import { generateId } from "../utils.ts";
import { sha256Hex } from "../crypto.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { decryptApiKey, encryptApiKey } from "../secrets.ts";
import { logger } from "../logger.ts";
import { metrics } from "../metrics.ts";
import { state } from "../state.ts";
import {
  getNextRevisionValue,
  recordApiKeyCacheRevision,
} from "./revisions.ts";
import {
  applyApiKeyValueIndexRelease,
  kvPlanApiKeyValueIndexRelease,
  valueIndexKey,
} from "./api-keys-index.ts";
import { waitForKvAtomicRetry } from "./atomic-retry.ts";

async function hydrateApiKey(value: unknown): Promise<ApiKey> {
  const persisted = assertCurrentApiKey(value);
  return { ...persisted, key: await decryptApiKey(persisted.encryptedKey) };
}
async function kvGetAllKeysWithSkipped(): Promise<
  { keys: ApiKey[]; skippedKeyIds: Set<string> }
> {
  const keys: ApiKey[] = [];
  const skippedKeyIds = new Set<string>();
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    try {
      keys.push(await hydrateApiKey(entry.value));
    } catch (error) {
      const rawId = entry.key[API_KEY_PREFIX.length];
      const keyId = typeof rawId === "string" ? rawId : undefined;
      if (keyId) skippedKeyIds.add(keyId); // string ids only — must match cachedKeysById to be skip-protected
      const fields = { keyId, kvKey: String(entry.key) };
      logger.warn("api_key_hydrate_failed", fields, error);
      metrics.inc("api_key_hydrate_failed_total", "skipped");
    }
  }
  return { keys, skippedKeyIds };
}
export async function kvGetAllKeys(): Promise<ApiKey[]> {
  return (await kvGetAllKeysWithSkipped()).keys;
}
export async function kvMergeAllApiKeysIntoCache(): Promise<void> {
  const { keys, skippedKeyIds } = await kvGetAllKeysWithSkipped();
  const loadedIds = new Set(keys.map((key) => key.id));
  for (const id of state.cachedKeysById.keys()) {
    if (!loadedIds.has(id) && !skippedKeyIds.has(id)) {
      state.cachedKeysById.delete(id);
      state.keyCooldownUntil.delete(id);
      state.dirtyKeyIds.delete(id);
    }
  }
  for (const key of keys) {
    const local = state.cachedKeysById.get(key.id);
    if (!local) {
      state.cachedKeysById.set(key.id, key);
      continue;
    }

    const isDirty = state.dirtyKeyIds.has(key.id);
    if (!isDirty) {
      state.cachedKeysById.set(key.id, key);
      continue;
    }

    local.key = key.key;
    local.encryptedKey = key.encryptedKey;
    local.createdAt = key.createdAt;
    if (!(local.status === "invalid" && key.status !== "invalid")) {
      local.status = key.status;
    }
    local.useCount = Math.max(local.useCount, key.useCount);
    local.lastUsed = Math.max(local.lastUsed ?? 0, key.lastUsed ?? 0) ||
      undefined;
  }
  rebuildActiveKeyIds();
}

export async function kvGetApiKeyById(id: string): Promise<ApiKey | null> {
  const cached = state.cachedKeysById.get(id);
  if (cached) return cached;

  const entry = await state.kv.get<PersistedApiKey>([...API_KEY_PREFIX, id]);
  if (!entry.value) return null;

  const hydrated = await hydrateApiKey(entry.value);
  state.cachedKeysById.set(id, hydrated);
  rebuildActiveKeyIds();
  return hydrated;
}

let lastApiKeyCreatedAtMs = 0;
export async function kvAddKey(
  key: string,
): Promise<{ success: boolean; id?: string; error?: string }> {
  // The in-memory cache check is an optimistic fast path: if THIS instance
  // already knows the value, skip the KV roundtrips. The authoritative
  // duplicate check is the value-index entry below, which catches the
  // multi-instance / stale-cache case described in issue #139.
  const allKeys = Array.from(state.cachedKeysById.values());
  const existingKey = allKeys.find((k) => k.key === key);
  if (existingKey) {
    return { success: false, error: "密钥已存在" };
  }

  const valueDigest = await sha256Hex(key);
  const indexKey = valueIndexKey(valueDigest);

  const id = generateId();
  const now = Date.now();
  const createdAt = now <= lastApiKeyCreatedAtMs
    ? lastApiKeyCreatedAtMs + 1
    : now;
  lastApiKeyCreatedAtMs = createdAt;
  const encryptedKey = await encryptApiKey(key);
  const newKey: ApiKey = {
    id,
    encryptedKey,
    key,
    useCount: 0,
    status: "active",
    createdAt,
  };

  const [revisionEntry, idEntry, indexEntry] = await Promise.all([
    state.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
    state.kv.get([...API_KEY_PREFIX, id]),
    state.kv.get<string>(indexKey),
  ]);
  if (idEntry.value !== null) {
    return { success: false, error: "密钥保存冲突，请重试" };
  }
  if (indexEntry.value !== null) {
    // Another instance (or a previous request that landed before this
    // instance's cache caught up) already persisted this exact value.
    return { success: false, error: "密钥已存在" };
  }
  const revision = getNextRevisionValue(revisionEntry);
  const result = await state.kv.atomic()
    .check(idEntry)
    .check(indexEntry)
    .check(revisionEntry)
    .set([...API_KEY_PREFIX, id], toPersistedApiKey(newKey))
    .set(indexKey, id)
    .set(API_KEY_CACHE_REVISION_KEY, revision)
    .commit();
  if (!result.ok) {
    // CAS lost — by far the most likely cause is another instance just
    // wrote the same plaintext via its own atomic. Re-read the index so
    // the caller (and ultimately the HTTP handler) gets the duplicate
    // error → 409 instead of the generic save-conflict error → 400.
    const postCheck = await state.kv.get<string>(indexKey);
    if (postCheck.value !== null) {
      return { success: false, error: "密钥已存在" };
    }
    return { success: false, error: "密钥保存失败，请重试" };
  }
  state.cachedKeysById.set(id, newKey);
  rebuildActiveKeyIds();
  recordApiKeyCacheRevision(revision);

  return { success: true, id };
}

export async function kvDeleteKey(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const key = [...API_KEY_PREFIX, id];
  const result = await state.kv.get(key);
  if (!result.value) {
    return { success: false, error: "密钥不存在" };
  }
  // Validate at the runtime boundary — the generic on state.kv.get is a
  // TypeScript-level promise, not a guarantee. A malformed / corrupted
  // record (migration bug, manual KV write, cross-version payload)
  // surfaces as the expected "格式不兼容" error here instead of a less
  // diagnosable TypeError on the next property access.
  const persisted = assertCurrentApiKey(result.value);

  // The index module owns digest resolution and the exceptional legacy-
  // duplicate scan. The delete path only consumes its release plan.
  const cached = state.cachedKeysById.get(id);
  const plaintext = cached?.key ??
    await decryptApiKey(persisted.encryptedKey);
  const [indexPlan, revisionEntry] = await Promise.all([
    kvPlanApiKeyValueIndexRelease(id, plaintext),
    state.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
  ]);
  const revision = getNextRevisionValue(revisionEntry);

  // Always CAS the index snapshot, including a missing legacy entry or an
  // entry owned by another duplicate. Promotion also CASes the replacement
  // record before moving ownership, so the transaction cannot create a
  // dangling index under a concurrent delete.
  let atomic = state.kv.atomic()
    .check(result)
    .check(indexPlan.indexEntry)
    .check(revisionEntry)
    .delete(key)
    .set(API_KEY_CACHE_REVISION_KEY, revision);
  atomic = applyApiKeyValueIndexRelease(atomic, indexPlan);

  const deleteResult = await atomic.commit();
  if (!deleteResult.ok) {
    return { success: false, error: "密钥删除失败，请重试" };
  }
  state.cachedKeysById.delete(id);
  state.keyCooldownUntil.delete(id);
  state.dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
  recordApiKeyCacheRevision(revision);
  return { success: true };
}

export async function kvUpdateKey(
  id: string,
  updates: Partial<ApiKey>,
): Promise<{ updated: boolean }> {
  const cached = state.cachedKeysById.get(id);
  if (!cached && !(await kvGetApiKeyById(id))) {
    return { updated: false };
  }

  const kvKey = [...API_KEY_PREFIX, id];

  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const [entry, revisionEntry] = await Promise.all([
      state.kv.get<PersistedApiKey>(kvKey),
      state.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
    ]);

    if (!entry.value) {
      const local = state.cachedKeysById.get(id);
      if (local) {
        state.cachedKeysById.delete(id);
        state.keyCooldownUntil.delete(id);
        state.dirtyKeyIds.delete(id);
        rebuildActiveKeyIds();
      }
      return { updated: false };
    }

    const persisted = await hydrateApiKey(entry.value);
    const local = state.cachedKeysById.get(id);
    const plaintext = local?.key ?? persisted.key;

    const useCount = updates.useCount ??
      Math.max(local?.useCount ?? 0, persisted.useCount);
    const lastUsed = updates.lastUsed ??
      (Math.max(local?.lastUsed ?? 0, persisted.lastUsed ?? 0) || undefined);

    const updated: ApiKey = {
      ...persisted,
      ...updates,
      key: plaintext,
      useCount,
      lastUsed,
    };

    const revision = getNextRevisionValue(revisionEntry);
    const result = await state.kv.atomic()
      .check(entry)
      .check(revisionEntry)
      .set(kvKey, toPersistedApiKey(updated))
      .set(API_KEY_CACHE_REVISION_KEY, revision)
      .commit();

    if (result.ok) {
      state.cachedKeysById.set(id, updated);
      rebuildActiveKeyIds();
      recordApiKeyCacheRevision(revision);
      return { updated: true };
    }

    await waitForKvAtomicRetry(attempt);
  }

  throw new Error("密钥更新失败：达到最大重试次数");
}
