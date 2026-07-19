import type { ApiKey } from "./types.ts";
import { isApiKeyFingerprint, isEncryptedApiKey } from "./secrets.ts";

export interface PersistedApiKey extends Omit<ApiKey, "key"> {
  fingerprint: string;
}

export function createPersistedApiKey(
  key: ApiKey,
  fingerprint: string,
): PersistedApiKey {
  const { key: _plaintext, ...persisted } = key;
  return { ...persisted, fingerprint };
}

function isApiKeyStatus(value: unknown): value is ApiKey["status"] {
  return value === "active" || value === "inactive" || value === "invalid";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Runtime-validates the complete persisted API-key schema. This store version
 * deliberately has no migration path: records without a blind fingerprint are
 * rejected so deployments cannot silently run with a partially indexed store.
 */
export function assertPersistedApiKey(value: unknown): PersistedApiKey {
  if (typeof value !== "object" || value === null) {
    throw new Error("API key 存储格式不兼容：记录不是对象");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("API key 存储格式不兼容：id 无效");
  }
  if (typeof raw.fingerprint !== "string") {
    throw new Error(
      "API key 存储格式不兼容：缺少 fingerprint，请清空并重新导入密钥",
    );
  }
  if (!isApiKeyFingerprint(raw.fingerprint)) {
    throw new Error("API key fingerprint 格式错误");
  }
  if (typeof raw.encryptedKey !== "string") {
    throw new Error("API key 存储格式不兼容：缺少 encryptedKey");
  }
  if (!isEncryptedApiKey(raw.encryptedKey)) {
    throw new Error("API key 密文格式错误");
  }
  if (!isNonNegativeFiniteNumber(raw.useCount)) {
    throw new Error("API key 存储格式不兼容：useCount 无效");
  }
  if (!isApiKeyStatus(raw.status)) {
    throw new Error("API key 存储格式不兼容：status 无效");
  }
  if (!isNonNegativeFiniteNumber(raw.createdAt)) {
    throw new Error("API key 存储格式不兼容：createdAt 无效");
  }
  if (
    raw.lastUsed !== undefined && !isNonNegativeFiniteNumber(raw.lastUsed)
  ) {
    throw new Error("API key 存储格式不兼容：lastUsed 无效");
  }
  return raw as unknown as PersistedApiKey;
}
