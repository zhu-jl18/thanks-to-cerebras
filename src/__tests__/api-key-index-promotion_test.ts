/**
 * Regression tests for issue #146: deleting the indexed owner of a
 * pre-existing duplicate must promote a surviving record without reopening
 * the stale-cache duplicate-write window.
 */

import { assertEquals } from "@std/assert";
import { API_KEY_PREFIX, API_KEY_VALUE_INDEX_PREFIX } from "../constants.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { sha256Hex } from "../crypto.ts";
import { kvAddKey, kvDeleteKey } from "../kv/api-keys.ts";
import { kvBackfillApiKeyValueIndex } from "../kv/api-keys-index.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { encryptApiKey } from "../secrets.ts";
import { setLogSinkForTests } from "../logger.ts";
import { AppState, state } from "../state.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";

interface DuplicatePair {
  plaintext: string;
  indexKey: Deno.KvKey;
  ownerId: string;
  successorId: string;
}

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  await resetKvRateLimitsForTests();
  await resetProxyStreamCountersForTests();
  metrics.reset();
  setLogSinkForTests(() => {});
  return kv;
}

async function persistLegacyApiKey(id: string, key: string): Promise<void> {
  await state.kv.set([...API_KEY_PREFIX, id], {
    id,
    encryptedKey: await encryptApiKey(key),
    useCount: 0,
    status: "active" as const,
    createdAt: Date.now(),
  });
}

async function seedDuplicatePair(plaintext: string): Promise<DuplicatePair> {
  const ids = ["legacy-duplicate-a", "legacy-duplicate-b"] as const;
  for (const id of ids) await persistLegacyApiKey(id, plaintext);

  const backfill = await kvBackfillApiKeyValueIndex();
  assertEquals(backfill.created, 1);
  assertEquals(backfill.preExistingDuplicates, 1);

  const digest = await sha256Hex(plaintext);
  const indexKey = [...API_KEY_VALUE_INDEX_PREFIX, digest];
  const indexEntry = await state.kv.get<string>(indexKey);
  if (typeof indexEntry.value !== "string") {
    throw new Error("expected backfill to create a value-index owner");
  }

  const ownerId = indexEntry.value;
  const successorId = ids.find((id) => id !== ownerId);
  if (!successorId) {
    throw new Error(`unexpected value-index owner: ${ownerId}`);
  }
  return { plaintext, indexKey, ownerId, successorId };
}

function clearApiKeyCache(): void {
  state.cachedKeysById.clear();
  rebuildActiveKeyIds();
}

Deno.test(
  "kvDeleteKey: promotes a surviving legacy duplicate and preserves protection",
  async () => {
    const kv = await setupKv();
    try {
      const fixture = await seedDuplicatePair("sk-index-promotion");

      const deletedOwner = await kvDeleteKey(fixture.ownerId);
      assertEquals(deletedOwner.success, true);

      const promotedIndex = await state.kv.get<string>(fixture.indexKey);
      assertEquals(promotedIndex.value, fixture.successorId);
      const oldOwner = await state.kv.get([
        ...API_KEY_PREFIX,
        fixture.ownerId,
      ]);
      assertEquals(oldOwner.value, null);
      const successor = await state.kv.get([
        ...API_KEY_PREFIX,
        fixture.successorId,
      ]);
      assertEquals(successor.value !== null, true);

      // Simulate another instance whose cache has not observed the survivor.
      // The promoted index remains authoritative and blocks a third record.
      clearApiKeyCache();
      const duplicate = await kvAddKey(fixture.plaintext);
      assertEquals(duplicate.success, false);
      assertEquals(duplicate.error, "密钥已存在");

      // Once the final owner is deleted, the digest becomes available again.
      const deletedSuccessor = await kvDeleteKey(fixture.successorId);
      assertEquals(deletedSuccessor.success, true);
      const removedIndex = await state.kv.get<string>(fixture.indexKey);
      assertEquals(removedIndex.value, null);

      const readded = await kvAddKey(fixture.plaintext);
      assertEquals(readded.success, true);
      assertEquals(readded.id !== fixture.ownerId, true);
      assertEquals(readded.id !== fixture.successorId, true);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvDeleteKey: aborts promotion when the selected successor disappears",
  async () => {
    const kv = await setupKv();
    try {
      const fixture = await seedDuplicatePair("sk-index-promotion-race");
      const originalAtomic = state.kv.atomic.bind(state.kv);
      let raced = false;
      state.kv.atomic = (() => {
        const tx = originalAtomic();
        const originalCommit = tx.commit.bind(tx);
        tx.commit = async () => {
          if (!raced) {
            raced = true;
            await state.kv.delete([
              ...API_KEY_PREFIX,
              fixture.successorId,
            ]);
          }
          return originalCommit();
        };
        return tx;
      }) as typeof state.kv.atomic;

      try {
        const result = await kvDeleteKey(fixture.ownerId);
        assertEquals(result.success, false);
        assertEquals(result.error, "密钥删除失败，请重试");
      } finally {
        state.kv.atomic = originalAtomic;
      }

      assertEquals(raced, true);
      const owner = await state.kv.get([
        ...API_KEY_PREFIX,
        fixture.ownerId,
      ]);
      assertEquals(owner.value !== null, true);
      const indexEntry = await state.kv.get<string>(fixture.indexKey);
      assertEquals(indexEntry.value, fixture.ownerId);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
