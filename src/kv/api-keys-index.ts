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

type ApiKeyValueIndexReplacementSearch =
  | { status: "found"; replacement: ApiKeyValueIndexReplacement }
  | { status: "not-found" }
  | { status: "blocked"; candidateId: string };

interface ApiKeyValueIndexReleaseBase {
  indexKey: Deno.KvKey;
  indexEntry: Deno.KvEntryMaybe<string>;
}

interface ApiKeyValueIndexReleaseBlocked {
  action: "blocked";
  candidateId: string;
}

export type ApiKeyValueIndexReleasePlan =
  | ApiKeyValueIndexReleaseBlocked
  | (ApiKeyValueIndexReleaseBase & { action: "preserve" | "delete" })
  | (ApiKeyValueIndexReleaseBase & {
    action: "promote";
    replacement: ApiKeyValueIndexReplacement;
  });

type ExecutableApiKeyValueIndexReleasePlan = Exclude<
  ApiKeyValueIndexReleasePlan,
  ApiKeyValueIndexReleaseBlocked
>;

export function valueIndexKey(digest: string): Deno.KvKey {
  return [...API_KEY_VALUE_INDEX_PREFIX, digest];
}

async function findApiKeyValueIndexReplacement(
  deletingId: string,
  plaintext: string,
): Promise<ApiKeyValueIndexReplacementSearch> {
  let unreadableCandidateId: string | undefined;
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
        return {
          status: "found",
          replacement: { id: candidateId, entry },
        };
      }
    } catch (error) {
      // Removing the index requires proving that no same-value record survives.
      // An unreadable candidate makes that proof incomplete: it may have been
      // encrypted under another secret or may still contain a legacy plaintext
      // value. Keep scanning in case a readable replacement exists, but fail
      // closed if the scan otherwise finds none.
      unreadableCandidateId ??= candidateId;
      logger.warn(
        "api_key_value_index_replacement_scan_failed",
        {
          keyId: candidateId,
          kvKey: String(entry.key),
        },
        error,
      );
    }
  }

  return unreadableCandidateId
    ? { status: "blocked", candidateId: unreadableCandidateId }
    : { status: "not-found" };
}

/**
 * Plans the index side of deleting an api-key record.
 *
 * Only the current index owner performs the authoritative KV scan. If a
 * pre-existing same-value duplicate survives, the plan promotes it; if the
 * scan proves none survives, the index is deleted. An unreadable candidate
 * blocks deletion because the scan cannot safely prove it is unrelated.
 */
export async function kvPlanApiKeyValueIndexRelease(
  id: string,
  plaintext: string,
): Promise<ApiKeyValueIndexReleasePlan> {
  const indexKey = valueIndexKey(await sha256Hex(plaintext));
  const indexEntry = await state.kv.get<string>(indexKey);
  const base = { indexKey, indexEntry };

  if (indexEntry.value !== id) return { ...base, action: "preserve" };

  const search = await findApiKeyValueIndexReplacement(id, plaintext);
  if (search.status === "found") {
    return { ...base, action: "promote", replacement: search.replacement };
  }
  if (search.status === "blocked") {
    return { action: "blocked", candidateId: search.candidateId };
  }
  return { ...base, action: "delete" };
}

/**
 * Applies an executable release plan to the caller's atomic operation. The
 * caller must CAS `plan.indexEntry`; promotion additionally CASes the
 * replacement record so a concurrent delete cannot leave the index pointing
 * at a vanished id.
 */
export function applyApiKeyValueIndexRelease(
  atomic: KvAtomicOperation,
  plan: ExecutableApiKeyValueIndexReleasePlan,
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
