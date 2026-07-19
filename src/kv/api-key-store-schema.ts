import type { ApiKey } from "../types.ts";
import {
  assertPersistedApiKey,
  type PersistedApiKey,
} from "../api-key-record.ts";
import { API_KEY_PREFIX, API_KEY_UNIQUE_PREFIX } from "../constants.ts";
import {
  decryptApiKey,
  fingerprintApiKey,
  isApiKeyFingerprint,
} from "../secrets.ts";

export type ApiKeyMetadata = Pick<
  ApiKey,
  "status" | "useCount" | "lastUsed"
>;

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
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  throw new ApiKeyStoreInvariantError(`${message}${detail}`, { cause });
}

export function assertApiKeyRecordEntry(
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
  if (
    persisted.id !== keyId ||
    (expectedId !== undefined && keyId !== expectedId)
  ) {
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

export async function hydrateApiKeyRecord(
  persisted: PersistedApiKey,
): Promise<ApiKey> {
  let plaintext: string;
  try {
    plaintext = await decryptApiKey(persisted.encryptedKey);
  } catch (error) {
    invariant("record ciphertext cannot be decrypted", error);
  }
  const actualFingerprint = await fingerprintApiKey(plaintext);
  if (actualFingerprint !== persisted.fingerprint) {
    invariant("record fingerprint does not match its ciphertext");
  }
  const { fingerprint: _fingerprint, ...apiKey } = persisted;
  return { ...apiKey, key: plaintext };
}

export function assertApiKeyMetadata(metadata: ApiKeyMetadata): void {
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

export async function loadVerifiedApiKeys(kv: Deno.Kv): Promise<ApiKey[]> {
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
}