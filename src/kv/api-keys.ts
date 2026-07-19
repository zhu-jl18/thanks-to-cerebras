import type { ApiKey } from "../types.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { state } from "../state.ts";
import { recordApiKeyCacheRevision } from "./revisions.ts";
import {
  createApiKeyStore,
  type ApiKeyUsageMergeResult,
} from "./api-key-store.ts";

export type AddApiKeyResult =
  | { ok: true; id: string }
  | { ok: false; code: "duplicate" | "conflict" };

export type DeleteApiKeyResult =
  | { ok: true }
  | {
    ok: false;
    code: "not-found" | "conflict" | "store-corrupt";
  };

export type ApiKeyUpdate = Partial<
  Pick<ApiKey, "status" | "useCount" | "lastUsed">
>;

function store() {
  return createApiKeyStore(state.kv);
}

function removeApiKeyFromCache(id: string): void {
  state.cachedKeysById.delete(id);
  state.keyCooldownUntil.delete(id);
  state.dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
}

export function kvGetAllKeys(): Promise<ApiKey[]> {
  return store().list();
}

export async function kvMergeAllApiKeysIntoCache(): Promise<void> {
  const keys = await kvGetAllKeys();
  const loadedIds = new Set(keys.map((key) => key.id));
  for (const id of state.cachedKeysById.keys()) {
    if (!loadedIds.has(id)) {
      state.cachedKeysById.delete(id);
      state.keyCooldownUntil.delete(id);
      state.dirtyKeyIds.delete(id);
    }
  }

  for (const key of keys) {
    const local = state.cachedKeysById.get(key.id);
    if (!local || !state.dirtyKeyIds.has(key.id)) {
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

  const key = await store().get(id);
  if (!key) return null;
  state.cachedKeysById.set(id, key);
  rebuildActiveKeyIds();
  return key;
}

export async function kvAddKey(key: string): Promise<AddApiKeyResult> {
  if (Array.from(state.cachedKeysById.values()).some((item) => item.key === key)) {
    return { ok: false, code: "duplicate" };
  }

  const result = await store().create(key);
  if (!result.ok) return result;

  state.cachedKeysById.set(result.key.id, result.key);
  rebuildActiveKeyIds();
  recordApiKeyCacheRevision(result.revision);
  return { ok: true, id: result.key.id };
}

export async function kvDeleteKey(id: string): Promise<DeleteApiKeyResult> {
  const result = await store().delete(id);
  if (!result.ok) return result;

  removeApiKeyFromCache(id);
  recordApiKeyCacheRevision(result.revision);
  return { ok: true };
}

export async function kvUpdateKey(
  id: string,
  updates: ApiKeyUpdate,
): Promise<{ updated: boolean }> {
  const local = state.cachedKeysById.get(id);
  const result = await store().update(id, (current) => ({
    status: updates.status ??
      (local?.status === "invalid" ? "invalid" : current.status),
    useCount: updates.useCount ??
      Math.max(local?.useCount ?? 0, current.useCount),
    lastUsed: updates.lastUsed ??
      (Math.max(local?.lastUsed ?? 0, current.lastUsed ?? 0) || undefined),
  }));

  if (!result.ok) {
    if (result.code === "not-found") {
      removeApiKeyFromCache(id);
      return { updated: false };
    }
    if (result.code === "store-corrupt") {
      throw new Error("API key 存储状态异常");
    }
    throw new Error("密钥更新失败：达到最大重试次数");
  }

  state.cachedKeysById.set(id, result.key);
  state.dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
  recordApiKeyCacheRevision(result.revision);
  return { updated: true };
}

export function kvMergeApiKeyUsage(
  id: string,
  useCount: number,
  lastUsed?: number,
): Promise<ApiKeyUsageMergeResult> {
  return store().mergeUsage(id, useCount, lastUsed);
}