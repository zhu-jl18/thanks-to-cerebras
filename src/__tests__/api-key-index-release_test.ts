/**
 * Regression tests for issue #146: deleting the record that owns a value index
 * must not expose a surviving pre-existing duplicate to stale-cache adds.
 */

import { assertEquals } from "@std/assert";
import { API_KEY_PREFIX } from "../constants.ts";
import { sha256Hex } from "../crypto.ts";
import { kvAddKey, kvDeleteKey } from "../kv/api-keys.ts";
import {
  kvBackfillApiKeyValueIndex,
  valueIndexKey,
} from "../kv/api-keys-index.ts";
import { setLogSinkForTests } from "../logger.ts";
import { encryptApiKey } from "../secrets.ts";
import { AppState, state } from "../state.ts";

async function openIsolatedKv(): Promise<Deno.Kv> {
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;
  setLogSinkForTests(() => {});
  return kv;
}

async function persistLegacyApiKey(
  id: string,
  plaintext: string,
): Promise<void> {
  await state.kv.set([...API_KEY_PREFIX, id], {
    id,
    encryptedKey: await encryptApiKey(plaintext),
    useCount: 0,
    status: "active" as const,
    createdAt: Date.now(),
  });
}

async function encryptApiKeyWithSecret(
  plaintext: string,
  secret: string,
): Promise<string> {
  const previousSecret = Deno.env.get("KEY_ENCRYPTION_SECRET");
  Deno.env.set("KEY_ENCRYPTION_SECRET", secret);
  try {
    return await encryptApiKey(plaintext);
  } finally {
    if (previousSecret === undefined) {
      Deno.env.delete("KEY_ENCRYPTION_SECRET");
    } else {
      Deno.env.set("KEY_ENCRYPTION_SECRET", previousSecret);
    }
  }
}

async function seedPreExistingDuplicate(
  plaintext: string,
): Promise<readonly [string, string]> {
  const ids = ["legacy-duplicate-a", "legacy-duplicate-b"] as const;
  await persistLegacyApiKey(ids[0], plaintext);
  await persistLegacyApiKey(ids[1], plaintext);
  assertEquals(await kvBackfillApiKeyValueIndex(), {
    created: 1,
    preExistingDuplicates: 1,
  });
  return ids;
}

async function getValueIndexOwner(plaintext: string): Promise<string | null> {
  const digest = await sha256Hex(plaintext);
  return (await state.kv.get<string>(valueIndexKey(digest))).value;
}

function findSurvivor(
  ids: readonly [string, string],
  owner: string,
): string {
  const survivor = ids.find((id) => id !== owner);
  if (!survivor || !ids.includes(owner as (typeof ids)[number])) {
    throw new Error(`unexpected value-index owner: ${owner}`);
  }
  return survivor;
}

async function countApiKeyRecords(): Promise<number> {
  let count = 0;
  for await (const entry of state.kv.list({ prefix: API_KEY_PREFIX })) {
    void entry;
    count++;
  }
  return count;
}

Deno.test(
  "kvDeleteKey: atomically promotes a surviving pre-existing duplicate",
  async () => {
    const kv = await openIsolatedKv();
    try {
      const plaintext = "sk-pre-existing-duplicate";
      const ids = await seedPreExistingDuplicate(plaintext);
      const owner = await getValueIndexOwner(plaintext);
      if (owner === null) {
        throw new Error("backfill did not create an index");
      }
      const survivor = findSurvivor(ids, owner);

      const deleted = await kvDeleteKey(owner);
      assertEquals(deleted.success, true);

      assertEquals(await getValueIndexOwner(plaintext), survivor);
      assertEquals(
        (await state.kv.get([...API_KEY_PREFIX, owner])).value,
        null,
      );
      assertEquals(
        (await state.kv.get([...API_KEY_PREFIX, survivor])).value !== null,
        true,
      );

      // Simulate a different instance whose cache has not observed either
      // legacy record. The promoted index owner remains authoritative.
      state.cachedKeysById.clear();
      state.cachedActiveKeyIds = [];
      const add = await kvAddKey(plaintext);
      assertEquals(add, { success: false, error: "密钥已存在" });
      assertEquals(await countApiKeyRecords(), 1);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvDeleteKey: unreadable survivor blocks removal of the only value index",
  async () => {
    const kv = await openIsolatedKv();
    try {
      const plaintext = "sk-unreadable-duplicate";
      const ids = await seedPreExistingDuplicate(plaintext);
      const owner = await getValueIndexOwner(plaintext);
      if (owner === null) {
        throw new Error("backfill did not create an index");
      }
      const survivor = findSurvivor(ids, owner);
      const survivorKey = [...API_KEY_PREFIX, survivor];
      const survivorEntry = await state.kv.get<Record<string, unknown>>(
        survivorKey,
      );
      if (survivorEntry.value === null) {
        throw new Error("expected surviving duplicate record");
      }

      // The record still represents the same plaintext, but its ciphertext was
      // produced with another secret and cannot be decrypted by this instance.
      const unreadableCiphertext = await encryptApiKeyWithSecret(
        plaintext,
        "different-key-encryption-secret",
      );
      await state.kv.set(survivorKey, {
        ...survivorEntry.value,
        encryptedKey: unreadableCiphertext,
      });

      const deleted = await kvDeleteKey(owner);
      assertEquals(deleted, {
        success: false,
        error: "密钥删除失败，请重试",
      });

      // The scan could not prove the survivor unrelated, so both the owner and
      // its index remain. A stale-cache add is still rejected authoritatively.
      assertEquals(
        (await state.kv.get([...API_KEY_PREFIX, owner])).value !== null,
        true,
      );
      assertEquals(
        (await state.kv.get([...API_KEY_PREFIX, survivor])).value !== null,
        true,
      );
      assertEquals(await getValueIndexOwner(plaintext), owner);

      state.cachedKeysById.clear();
      state.cachedActiveKeyIds = [];
      const add = await kvAddKey(plaintext);
      assertEquals(add, { success: false, error: "密钥已存在" });
      assertEquals(await countApiKeyRecords(), 2);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvDeleteKey: promotion CAS rejects a concurrently deleted survivor",
  async () => {
    const kv = await openIsolatedKv();
    try {
      const plaintext = "sk-concurrent-survivor-delete";
      const ids = await seedPreExistingDuplicate(plaintext);
      const owner = await getValueIndexOwner(plaintext);
      if (owner === null) {
        throw new Error("backfill did not create an index");
      }
      const survivor = findSurvivor(ids, owner);

      const originalAtomic = state.kv.atomic.bind(state.kv);
      let raced = false;
      state.kv.atomic = (() => {
        const tx = originalAtomic();
        const originalCommit = tx.commit.bind(tx);
        tx.commit = async () => {
          if (!raced) {
            raced = true;
            await state.kv.delete([...API_KEY_PREFIX, survivor]);
          }
          return originalCommit();
        };
        return tx;
      }) as typeof state.kv.atomic;

      try {
        const deleted = await kvDeleteKey(owner);
        assertEquals(deleted, {
          success: false,
          error: "密钥删除失败，请重试",
        });
      } finally {
        state.kv.atomic = originalAtomic;
      }

      // The candidate's versionstamp changed before commit, so the whole
      // owner-delete/index-promotion transaction must have rolled back.
      assertEquals(raced, true);
      assertEquals(
        (await state.kv.get([...API_KEY_PREFIX, owner])).value !== null,
        true,
      );
      assertEquals(
        (await state.kv.get([...API_KEY_PREFIX, survivor])).value,
        null,
      );
      assertEquals(await getValueIndexOwner(plaintext), owner);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
