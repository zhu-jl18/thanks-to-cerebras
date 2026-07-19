/**
 * Greenfield API-key store tests: record and blind-fingerprint claim form a
 * strict one-to-one relation maintained by the same atomic transaction.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { API_KEY_PREFIX, API_KEY_UNIQUE_PREFIX } from "../constants.ts";
import { fingerprintApiKey, isApiKeyFingerprint } from "../secrets.ts";
import {
  kvAddKey,
  kvDeleteKey,
  kvGetAllKeys,
  kvUpdateKey,
} from "../kv/api-keys.ts";
import { apiKeyUniqueClaimKey } from "../kv/api-key-store.ts";
import { setLogSinkForTests } from "../logger.ts";
import { AppState, state } from "../state.ts";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  setLogSinkForTests(() => {});
  return kv;
}

async function requireCreated(plaintext: string): Promise<string> {
  const result = await kvAddKey(plaintext);
  if (!result.ok) throw new Error(`create failed: ${result.code}`);
  return result.id;
}

async function countPrefix(prefix: Deno.KvKey): Promise<number> {
  let count = 0;
  for await (const entry of state.kv.list({ prefix })) {
    void entry;
    count++;
  }
  return count;
}

Deno.test("fingerprintApiKey: deterministic, keyed, and non-revealing", async () => {
  Deno.env.set("KEY_ENCRYPTION_SECRET", "fingerprint-secret-a");
  const first = await fingerprintApiKey("sk-fingerprint-value");
  const second = await fingerprintApiKey("sk-fingerprint-value");
  const differentValue = await fingerprintApiKey("sk-fingerprint-other");

  Deno.env.set("KEY_ENCRYPTION_SECRET", "fingerprint-secret-b");
  const differentDeployment = await fingerprintApiKey("sk-fingerprint-value");

  assertEquals(first, second);
  assertEquals(first !== differentValue, true);
  assertEquals(first !== differentDeployment, true);
  assertEquals(isApiKeyFingerprint(first), true);
  assertEquals(first.includes("sk-fingerprint-value"), false);
});

Deno.test(
  "kvAddKey: atomically creates one record and one unique claim",
  async () => {
    const kv = await setupKv();
    try {
      const plaintext = "sk-atomic-claim";
      const id = await requireCreated(plaintext);
      const record = await state.kv.get<Record<string, unknown>>([
        ...API_KEY_PREFIX,
        id,
      ]);
      const fingerprint = record.value?.fingerprint;
      if (typeof fingerprint !== "string") {
        throw new Error("persisted fingerprint missing");
      }

      assertEquals(
        (await state.kv.get<string>(apiKeyUniqueClaimKey(fingerprint))).value,
        id,
      );
      assertEquals(await countPrefix(API_KEY_PREFIX), 1);
      assertEquals(await countPrefix(API_KEY_UNIQUE_PREFIX), 1);

      // A stale instance has no plaintext cache, but the claim is authoritative.
      state.cachedKeysById.clear();
      state.cachedActiveKeyIds = [];
      assertEquals(await kvAddKey(plaintext), {
        ok: false,
        code: "duplicate",
      });
      assertEquals(await countPrefix(API_KEY_PREFIX), 1);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvAddKey: concurrent same-value creates converge on one claim owner",
  async () => {
    const kv = await setupKv();
    try {
      const results = await Promise.all([
        kvAddKey("sk-concurrent-claim"),
        kvAddKey("sk-concurrent-claim"),
      ]);
      assertEquals(results.filter((result) => result.ok).length, 1);
      assertEquals(
        results.filter((result) => !result.ok && result.code === "duplicate")
          .length,
        1,
      );
      assertEquals(await countPrefix(API_KEY_PREFIX), 1);
      assertEquals(await countPrefix(API_KEY_UNIQUE_PREFIX), 1);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvDeleteKey: deletes record and claim in O(1) without decrypting or listing",
  async () => {
    const kv = await setupKv();
    const originalList = kv.list.bind(kv);
    try {
      const plaintext = "sk-delete-without-scan";
      const id = await requireCreated(plaintext);
      const record = await kv.get<Record<string, unknown>>([
        ...API_KEY_PREFIX,
        id,
      ]);
      const fingerprint = record.value?.fingerprint;
      if (typeof fingerprint !== "string") {
        throw new Error("fingerprint missing");
      }

      // Neither the root secret nor a prefix scan is needed to delete: the
      // persisted fingerprint directly identifies the paired unique claim.
      Deno.env.set("KEY_ENCRYPTION_SECRET", "intentionally-wrong-secret");
      kv.list = (() => {
        throw new Error("delete must not scan KV");
      }) as typeof kv.list;

      assertEquals(await kvDeleteKey(id), { ok: true });
      assertEquals((await kv.get([...API_KEY_PREFIX, id])).value, null);
      assertEquals(
        (await kv.get(apiKeyUniqueClaimKey(fingerprint))).value,
        null,
      );

      kv.list = originalList;
      Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
      const readded = await kvAddKey(plaintext);
      assertEquals(readded.ok, true);
    } finally {
      kv.list = originalList;
      Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvGetAllKeys: rejects the old record schema instead of silently degrading",
  async () => {
    const kv = await setupKv();
    try {
      await kv.set([...API_KEY_PREFIX, "legacy-record"], {
        id: "legacy-record",
        encryptedKey: "v1$aes-gcm$legacy$legacy",
        useCount: 0,
        status: "active",
        createdAt: 1,
      });

      await assertRejects(
        () => kvGetAllKeys(),
        Error,
        "缺少 fingerprint",
      );
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test("kvGetAllKeys: rejects a record whose claim is missing", async () => {
  const kv = await setupKv();
  try {
    const id = await requireCreated("sk-missing-claim");
    const record = await kv.get<Record<string, unknown>>([
      ...API_KEY_PREFIX,
      id,
    ]);
    const fingerprint = record.value?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("fingerprint missing");
    await kv.delete(apiKeyUniqueClaimKey(fingerprint));
    state.cachedKeysById.clear();

    await assertRejects(
      () => kvGetAllKeys(),
      Error,
      "record and unique-claim counts differ",
    );
    assertEquals(await kvDeleteKey(id), {
      ok: false,
      code: "store-corrupt",
    });
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("kvGetAllKeys: rejects a dangling unique claim", async () => {
  const kv = await setupKv();
  try {
    const fingerprint = await fingerprintApiKey("sk-dangling-claim");
    await kv.set(apiKeyUniqueClaimKey(fingerprint), "missing-owner");

    await assertRejects(
      () => kvGetAllKeys(),
      Error,
      "record and unique-claim counts differ",
    );
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test(
  "kvGetAllKeys: verifies fingerprint against decrypted plaintext",
  async () => {
    const kv = await setupKv();
    try {
      const id = await requireCreated("sk-fingerprint-integrity");
      const recordKey = [...API_KEY_PREFIX, id];
      const entry = await kv.get<Record<string, unknown>>(recordKey);
      if (entry.value === null) throw new Error("record missing");
      const originalFingerprint = entry.value.fingerprint;
      if (typeof originalFingerprint !== "string") {
        throw new Error("fingerprint missing");
      }
      const wrongFingerprint = await fingerprintApiKey("sk-different-value");
      await kv.atomic()
        .check(entry)
        .delete(apiKeyUniqueClaimKey(originalFingerprint))
        .set(recordKey, { ...entry.value, fingerprint: wrongFingerprint })
        .set(apiKeyUniqueClaimKey(wrongFingerprint), id)
        .commit();
      state.cachedKeysById.clear();

      await assertRejects(
        () => kvGetAllKeys(),
        Error,
        "fingerprint does not match",
      );
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test("kvUpdateKey: preserves fingerprint and claim ownership", async () => {
  const kv = await setupKv();
  try {
    const id = await requireCreated("sk-update-preserves-claim");
    const before = await kv.get<Record<string, unknown>>([
      ...API_KEY_PREFIX,
      id,
    ]);
    const fingerprint = before.value?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("fingerprint missing");

    assertEquals(await kvUpdateKey(id, { status: "inactive" }), {
      updated: true,
    });
    const after = await kv.get<Record<string, unknown>>([
      ...API_KEY_PREFIX,
      id,
    ]);
    assertEquals(after.value?.fingerprint, fingerprint);
    assertEquals(after.value?.status, "inactive");
    assertEquals(
      (await kv.get<string>(apiKeyUniqueClaimKey(fingerprint))).value,
      id,
    );
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test(
  "kvDeleteKey: claim CAS prevents deleting through a concurrent owner change",
  async () => {
    const kv = await setupKv();
    try {
      const id = await requireCreated("sk-delete-claim-race");
      const record = await kv.get<Record<string, unknown>>([
        ...API_KEY_PREFIX,
        id,
      ]);
      const fingerprint = record.value?.fingerprint;
      if (typeof fingerprint !== "string") {
        throw new Error("fingerprint missing");
      }
      const claimKey = apiKeyUniqueClaimKey(fingerprint);

      const originalAtomic = kv.atomic.bind(kv);
      let raced = false;
      kv.atomic = (() => {
        const operation = originalAtomic();
        const originalCommit = operation.commit.bind(operation);
        operation.commit = async () => {
          if (!raced) {
            raced = true;
            await kv.set(claimKey, "concurrent-owner");
          }
          return originalCommit();
        };
        return operation;
      }) as typeof kv.atomic;

      try {
        assertEquals(await kvDeleteKey(id), {
          ok: false,
          code: "store-corrupt",
        });
      } finally {
        kv.atomic = originalAtomic;
      }

      assertEquals(raced, true);
      assertEquals(
        (await kv.get([...API_KEY_PREFIX, id])).value !== null,
        true,
      );
      assertEquals((await kv.get<string>(claimKey)).value, "concurrent-owner");
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
