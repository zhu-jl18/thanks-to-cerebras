import { assertEquals } from "@std/assert";
import { AppState, state } from "../state.ts";
import { kvGetApiKeyById, kvUpdateKey } from "../kv/api-keys.ts";
import { markKeyInvalid } from "../api-keys.ts";
import { API_KEY_PREFIX } from "../constants.ts";
import { setLogSinkForTests } from "../logger.ts";
import { testKey } from "../services/api-keys.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  setLogSinkForTests(() => {});
  return kv;
}

Deno.test(
  "kvUpdateKey: retries on atomic conflict and eventually succeeds",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-retry-test-key");
    await kvGetApiKeyById(id);

    const originalAtomic = kv.atomic.bind(kv);
    let callCount = 0;
    kv.atomic = () => {
      callCount++;
      const operation = originalAtomic();
      if (callCount <= 2) {
        operation.commit = () =>
          Promise.resolve(
            { ok: false } as unknown as Deno.KvCommitResult,
          );
      }
      return operation;
    };

    try {
      const result = await kvUpdateKey(id, { status: "inactive" });
      assertEquals(result.updated, true);
      assertEquals(state.cachedKeysById.get(id)?.status, "inactive");
    } finally {
      kv.atomic = originalAtomic;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvUpdateKey: retries against the latest cache object",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-retry-fresh-cache");
    const originalAtomic = kv.atomic.bind(kv);
    let failedOnce = false;

    kv.atomic = () => {
      const operation = originalAtomic();
      const originalCommit = operation.commit.bind(operation);
      operation.commit = async () => {
        if (!failedOnce) {
          failedOnce = true;
          const cached = state.cachedKeysById.get(id);
          if (!cached) throw new Error("cached key missing");
          state.cachedKeysById.set(id, {
            ...cached,
            useCount: 9,
            lastUsed: 1_234,
          });
          return { ok: false } as unknown as Deno.KvCommitResult;
        }
        return originalCommit();
      };
      return operation;
    };

    try {
      assertEquals(await kvUpdateKey(id, { status: "inactive" }), {
        updated: true,
      });
      const persisted = await kv.get<Record<string, unknown>>([
        ...API_KEY_PREFIX,
        id,
      ]);
      assertEquals(persisted.value?.useCount, 9);
      assertEquals(persisted.value?.lastUsed, 1_234);
    } finally {
      kv.atomic = originalAtomic;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvUpdateKey: returns updated false and cleans cache when record is missing",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-missing-entry-test");
    await kvGetApiKeyById(id);

    state.dirtyKeyIds.add(id);
    state.keyCooldownUntil.set(id, Date.now() + 60_000);
    await kv.delete([...API_KEY_PREFIX, id]);

    try {
      const result = await kvUpdateKey(id, { status: "inactive" });
      assertEquals(result.updated, false);
      assertEquals(state.cachedKeysById.has(id), false);
      assertEquals(state.keyCooldownUntil.has(id), false);
      assertEquals(state.dirtyKeyIds.has(id), false);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvUpdateKey: returns updated false when key is absent from memory and KV",
  async () => {
    const kv = await setupKv();
    try {
      const result = await kvUpdateKey("nonexistent-id", {
        status: "inactive",
      });
      assertEquals(result.updated, false);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "markKeyInvalid: retries atomic conflicts until status is persisted",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-invalid-retry-test");
    await kvGetApiKeyById(id);

    const originalAtomic = kv.atomic.bind(kv);
    let commitCount = 0;
    kv.atomic = () => {
      const operation = originalAtomic();
      const originalCommit = operation.commit.bind(operation);
      operation.commit = () => {
        commitCount++;
        if (commitCount <= 2) {
          return Promise.resolve(
            { ok: false } as unknown as Deno.KvCommitResult,
          );
        }
        return originalCommit();
      };
      return operation;
    };

    try {
      await markKeyInvalid(id);
      assertEquals(commitCount, 3);
      assertEquals(state.dirtyKeyIds.has(id), false);
      assertEquals(state.cachedKeysById.get(id)?.status, "invalid");
      const entry = await kv.get([...API_KEY_PREFIX, id]);
      assertEquals((entry.value as { status: string }).status, "invalid");
    } finally {
      kv.atomic = originalAtomic;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "markKeyInvalid: dirty marker survives retry exhaustion",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-dirty-fail-test");
    await kvGetApiKeyById(id);
    state.dirtyKeyIds.add(id);

    const originalAtomic = kv.atomic.bind(kv);
    let commitCount = 0;
    kv.atomic = () => {
      const operation = originalAtomic();
      operation.commit = () => {
        commitCount++;
        if (commitCount < 10) {
          return Promise.resolve(
            { ok: false } as unknown as Deno.KvCommitResult,
          );
        }
        throw new Error("forced atomic failure after retry exhaustion");
      };
      return operation;
    };

    try {
      await markKeyInvalid(id);
      assertEquals(commitCount, 10);
      assertEquals(state.dirtyKeyIds.has(id), true);
      assertEquals(state.cachedKeysById.get(id)?.status, "invalid");
    } finally {
      kv.atomic = originalAtomic;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test("markKeyInvalid: clears dirty marker on commit success", async () => {
  const kv = await setupKv();
  const id = await addTestApiKey("sk-dirty-success-test");
  await kvGetApiKeyById(id);
  state.dirtyKeyIds.add(id);

  try {
    await markKeyInvalid(id);
    assertEquals(state.dirtyKeyIds.has(id), false);
    assertEquals(state.cachedKeysById.get(id)?.status, "invalid");
    const entry = await kv.get([...API_KEY_PREFIX, id]);
    assertEquals((entry.value as { status: string }).status, "invalid");
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test(
  "testKey: reports missing when the record is concurrently deleted",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-concurrent-delete-test");
    await kvGetApiKeyById(id);
    state.cachedModelPool = ["test-model"];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response("{}", { status: 200 }));
    await kv.delete([...API_KEY_PREFIX, id]);

    try {
      const result = await testKey(id);
      assertEquals(result.success, false);
      assertEquals(result.status, "invalid");
      assertEquals(result.error, "密钥不存在");
    } finally {
      globalThis.fetch = originalFetch;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
