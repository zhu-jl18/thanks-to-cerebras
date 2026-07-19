/**
 * Secondary index for api-key plaintext values: sha256(value) → id.
 * The index lets `kvAddKey` reject same-value duplicates even when the
 * caller's in-memory cache is stale (e.g. another instance just added
 * the same value, or the local revision check has not caught up).
 *
 * Pre-existing duplicates may still exist from before the index was
 * introduced. When the indexed record is deleted, release planning promotes
 * one surviving duplicate in the same atomic transaction so protection never
 * disappears between delete and the next bootstrap.
 *
 * Issues #139 and #146.
 */

import { API_KEY_PREFIX, API_KEY_VALUE_INDEX_PREFIX } from "../constants.ts";
import { assertCurrentApiKey } from "../api-key-record.ts";
import { sha256Hex } from "../crypto.ts";
import { decryptApiKey } from "../secrets.ts";
import { logger } from "../logger.ts";
import { state } from "../state.ts";

type KvAtomicOperation = ReturnType<Deno.Kv["atomic"]>;

interface ApiKeyValueIndexReplacement {
  id: string;
  entry: Deno.KvEntry<unknown>;
}

interface ApiKeyValueIndexReleaseBase {
  indexKey: Deno.KvKey;
  indexEntry: Deno.KvEntryMaybe<string>;
}

export type ApiKeyValueIndexReleasePlan =
  | (ApiKeyValueIndexReleaseBase & { action: "preserve" | "delete" })
  | (ApiKeyValueIndexReleaseBase & {
    action: "promote";
    replacement: ApiKeyValueIndexReplacement;
  });

export function valueIndexKey(digest: string): Deno.KvKey {
  return [...API_KEY_VALUE_INDEX_PREFIX, digest];
}

async function findApiKeyValueIndexReplacement(
  deletingId: string,
  plaintext: string,
): Promise<ApiKeyValueIndexReplacement | null> {
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    const candidateId = entry.key[API_KEY_PREFIX.length];
    if (
      entry.key.length !== API_KEY_PREFIX.length + 1 ||
      typeof candidateId !== "string" || candidateId === deletingId
    ) {
      continue;
    }

    try {
      const persisted = assertCurrentApiKey(entry.value);
      const candidatePlaintext = await decryptApiKey(persisted.encryptedKey);
      if (candidatePlaintext === plaintext) {
        return { id: candidateId, entry };
      }
    } catch (error) {
      // A malformed unrelated record must not prevent an admin from deleting
      // a valid key. It cannot safely become the replacement owner, so skip it
      // and preserve the same diagnostic shape used by cache hydration.
      logger.warn("api_key_value_index_replacement_scan_skipped", {
        keyId: candidateId,
        kvKey: String(entry.key),
      }, error);
    }
  }
  return null;
}

/**
 * Plans the index side of deleting an api-key record.
 *
 * Only the current index owner performs the authoritative KV scan. If a
 * pre-existing same-value duplicate survives, the plan promotes it; otherwise
 * the index is deleted. A record that does not own the index leaves it intact.
 */
export async function kvPlanApiKeyValueIndexRelease(
  id: string,
  plaintext: string,
): Promise<ApiKeyValueIndexReleasePlan> {
  const indexKey = valueIndexKey(await sha256Hex(plaintext));
  const indexEntry = await state.kv.get<string>(indexKey);
  const base = { indexKey, indexEntry };

  if (indexEntry.value !== id) return { ...base, action: "preserve" };

  const replacement = await findApiKeyValueIndexReplacement(id, plaintext);
  return replacement
    ? { ...base, action: "promote", replacement }
    : { ...base, action: "delete" };
}

/**
 * Applies a release plan to the caller's atomic operation. The caller must CAS
 * `plan.indexEntry`; promotion additionally CASes the replacement record so a
 * concurrent delete cannot leave the index pointing at a vanished id.
 */
export function applyApiKeyValueIndexRelease(
  atomic: KvAtomicOperation,
  plan: ApiKeyValueIndexReleasePlan,
): KvAtomicOperation {
  switch (plan.action) {
    case "preserve":
      return atomic;
    case "delete":
      return atomic.delete(plan.indexKey);
    case "promote":
      return atomic
        .check(plan.replacement.entry)
        .set(plan.indexKey, plan.replacement.id);
  }
}

/**
 * Walks the api-keys KV prefix and ensures every record has a matching
 * value-index entry. Idempotent — safe to run on every cold start.
 *
 * Behaviour:
 * - Missing index → atomically create it pointing at the record's id.
 * - Existing index points at this id → no-op.
 * - Existing index points at a different id → log warn but do not
 *   overwrite or delete either record. A backfill path repairs missing
 *   indexes; it must not choose which user data to discard.
 *
 * Concurrency: a CAS conflict means another instance won the race for
 * the same digest; treat as success (the entry is now there). Any other
 * error is surfaced so the caller can decide whether to fail bootstrap.
 */
export async function kvBackfillApiKeyValueIndex(): Promise<{
  created: number;
  preExistingDuplicates: number;
}> {
  let created = 0;
  let preExistingDuplicates = 0;
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    const persisted = assertCurrentApiKey(entry.value);
    const plaintext = await decryptApiKey(persisted.encryptedKey);
    const digest = await sha256Hex(plaintext);
    const indexKey = valueIndexKey(digest);
    const indexEntry = await state.kv.get<string>(indexKey);
    if (indexEntry.value === persisted.id) continue;
    if (indexEntry.value !== null && indexEntry.value !== persisted.id) {
      preExistingDuplicates++;
      logger.warn("api_key_value_index_pre_existing_duplicate", {
        keptId: indexEntry.value,
        duplicateId: persisted.id,
      });
      continue;
    }
    const result = await state.kv.atomic()
      .check(entry)
      .check(indexEntry)
      .set(indexKey, persisted.id)
      .commit();
    if (result.ok) created++;
    // CAS lost: either another instance set the index for this digest
    // first (idempotent if it points at our id; surfaced next iteration
    // if at a duplicate), or the main record was concurrently modified
    // / deleted (in which case writing the index would have produced a
    // dangling pointer). The current run does not need to retry —
    // `entry` is now stale anyway.
  }
  return { created, preExistingDuplicates };
}
