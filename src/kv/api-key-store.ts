import type { ApiKey } from "../types.ts";
import {
  type ApiKeyStoreCreateResult,
  type ApiKeyStoreDeleteResult,
  type ApiKeyStoreUpdateResult,
  type ApiKeyUsageMergeResult,
  createApiKey,
  deleteApiKey,
  getApiKey,
  mergeApiKeyUsage,
  updateApiKey,
} from "./api-key-store-operations.ts";
import {
  type ApiKeyMetadata,
  ApiKeyStoreInvariantError,
  apiKeyUniqueClaimKey,
  loadVerifiedApiKeys,
} from "./api-key-store-schema.ts";

export { ApiKeyStoreInvariantError, apiKeyUniqueClaimKey };
export type {
  ApiKeyStoreCreateResult,
  ApiKeyStoreDeleteResult,
  ApiKeyStoreUpdateResult,
  ApiKeyUsageMergeResult,
} from "./api-key-store-operations.ts";

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

class DenoKvApiKeyStore implements ApiKeyStore {
  constructor(private readonly kv: Deno.Kv) {}

  list(): Promise<ApiKey[]> {
    return loadVerifiedApiKeys(this.kv);
  }

  get(id: string): Promise<ApiKey | null> {
    return getApiKey(this.kv, id);
  }

  create(plaintext: string): Promise<ApiKeyStoreCreateResult> {
    return createApiKey(this.kv, plaintext);
  }

  delete(id: string): Promise<ApiKeyStoreDeleteResult> {
    return deleteApiKey(this.kv, id);
  }

  update(
    id: string,
    mutate: (current: Readonly<ApiKey>) => ApiKeyMetadata,
  ): Promise<ApiKeyStoreUpdateResult> {
    return updateApiKey(this.kv, id, mutate);
  }

  mergeUsage(
    id: string,
    useCount: number,
    lastUsed?: number,
  ): Promise<ApiKeyUsageMergeResult> {
    return mergeApiKeyUsage(this.kv, id, useCount, lastUsed);
  }
}

export function createApiKeyStore(kv: Deno.Kv): ApiKeyStore {
  return new DenoKvApiKeyStore(kv);
}
