import { assertEquals, assertRejects } from "@std/assert";
import { CEREBRAS_PUBLIC_MODELS_URL } from "../constants.ts";
import { AppState, state } from "../state.ts";
import { refreshModelCatalog } from "../kv/model-catalog.ts";
import { kvGetApiKeyById } from "../kv/api-keys.ts";
import { testKey } from "../services/api-keys.ts";
import {
  getUpstreamCircuitPermit,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  resetUpstreamCircuitForTests,
} from "../services/upstream-circuit-breaker.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  resetUpstreamCircuitForTests();
  return kv;
}

Deno.test(
  "refreshModelCatalog - rejects malformed JSON without caching empty catalog",
  async () => {
    const kv = await setupKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL) => {
      assertEquals(String(input), CEREBRAS_PUBLIC_MODELS_URL);
      return Promise.resolve(new Response("{not json", { status: 200 }));
    };

    try {
      await assertRejects(
        () => refreshModelCatalog(),
        Error,
        "模型目录响应不是有效 JSON",
      );
      assertEquals(state.cachedModelCatalog, null);
    } finally {
      globalThis.fetch = originalFetch;
      kv.close();
    }
  },
);

Deno.test(
  "refreshModelCatalog - rejects payloads without data array",
  async () => {
    const kv = await setupKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [{ id: "wrong-shape" }] }), {
          status: 200,
        }),
      );

    try {
      await assertRejects(
        () => refreshModelCatalog(),
        Error,
        "模型目录响应缺少 data 数组",
      );
      assertEquals(state.cachedModelCatalog, null);
    } finally {
      globalThis.fetch = originalFetch;
      kv.close();
    }
  },
);

Deno.test(
  "testKey - does not mark keys active when model pool is empty",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-empty-model-pool");
    await kvGetApiKeyById(id);
    state.cachedModelPool = [];

    const result = await testKey(id);

    assertEquals(result, {
      success: false,
      status: "error",
      error: "模型池为空",
    });
    assertEquals(state.cachedKeysById.get(id)?.status, "active");
    kv.close();
  },
);

Deno.test("refreshModelCatalog - rejects null JSON body", async () => {
  const kv = await setupKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("null", { status: 200 }));

  try {
    await assertRejects(
      () => refreshModelCatalog(),
      Error,
      "模型目录响应格式错误",
    );
    assertEquals(state.cachedModelCatalog, null);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("upstreamCircuitBreaker - opens after threshold failures", async () => {
  const kv = await setupKv();
  const now = Date.now();

  recordUpstreamFailure(now);
  assertEquals(getUpstreamCircuitPermit(now).allowed, true);
  recordUpstreamFailure(now);
  assertEquals(getUpstreamCircuitPermit(now).allowed, true);
  recordUpstreamFailure(now);

  const permit = getUpstreamCircuitPermit(now);
  assertEquals(permit.allowed, false);
  if (!permit.allowed) assertEquals(permit.retryAfterSec > 0, true);

  kv.close();
});

Deno.test("upstreamCircuitBreaker - half-open success closes", async () => {
  const kv = await setupKv();
  const now = Date.now();

  recordUpstreamFailure(now);
  recordUpstreamFailure(now);
  recordUpstreamFailure(now);
  assertEquals(getUpstreamCircuitPermit(now + 31_000).allowed, true);

  recordUpstreamSuccess();

  assertEquals(getUpstreamCircuitPermit(now + 31_001).allowed, true);
  assertEquals(state.upstreamCircuitFailureCount, 0);

  kv.close();
});

Deno.test("upstreamCircuitBreaker - half-open failure reopens", async () => {
  const kv = await setupKv();
  const now = Date.now();

  recordUpstreamFailure(now);
  recordUpstreamFailure(now);
  recordUpstreamFailure(now);
  assertEquals(getUpstreamCircuitPermit(now + 31_000).allowed, true);
  recordUpstreamFailure(now + 31_000);

  const reopened = getUpstreamCircuitPermit(now + 31_001);
  assertEquals(reopened.allowed, false);

  kv.close();
});
