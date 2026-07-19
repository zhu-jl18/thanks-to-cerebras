import { assertEquals } from "@std/assert";
import {
  CEREBRAS_API_URL,
  UPSTREAM_CIRCUIT_FAILURE_THRESHOLD,
} from "../constants.ts";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

const BASE = "http://localhost";

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

function makeReq(body: unknown): Request {
  return new Request(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function installUpstreamResponse(response: () => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
    assertEquals(String(input), CEREBRAS_API_URL);
    return Promise.resolve(response());
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test("proxy circuit: opens after repeated 5xx responses", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());
  state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
  await addTestApiKey("sk-upstream-test");
  let fetchCount = 0;
  const restoreFetch = installUpstreamResponse(() => {
    fetchCount += 1;
    return new Response(JSON.stringify({ error: "temporary outage" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    for (let i = 0; i < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD; i++) {
      const response = await handler(
        makeReq({ messages: [{ role: "user", content: "hi" }] }),
      );
      assertEquals(response.status, 503);
      await response.body?.cancel();
    }

    const openResponse = await handler(
      makeReq({ messages: [{ role: "user", content: "hi" }] }),
    );
    assertEquals(openResponse.status, 503);
    assertEquals(openResponse.headers.has("Retry-After"), true);
    const body = await openResponse.json();
    assertEquals(body.error.code, "upstream_circuit_open");
    assertEquals(fetchCount, UPSTREAM_CIRCUIT_FAILURE_THRESHOLD);
  } finally {
    setLogSinkForTests(null);
    restoreFetch();
    kv.close();
  }
});

Deno.test("proxy circuit: ignores key errors", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());
  state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
  for (let i = 0; i < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD; i++) {
    await addTestApiKey(`sk-upstream-test-${i}`);
  }
  let fetchCount = 0;
  const restoreFetch = installUpstreamResponse(() => {
    fetchCount += 1;
    return new Response(JSON.stringify({ error: "bad key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    for (let i = 0; i < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD; i++) {
      const response = await handler(
        makeReq({ messages: [{ role: "user", content: "hi" }] }),
      );
      assertEquals(response.status, 401);
      await response.body?.cancel();
    }
    assertEquals(fetchCount, UPSTREAM_CIRCUIT_FAILURE_THRESHOLD);
    assertEquals(state.upstreamCircuitOpenedUntil, 0);
  } finally {
    setLogSinkForTests(null);
    restoreFetch();
    kv.close();
  }
});

Deno.test(
  "proxy circuit: still opens when 5xx alternates with 4xx (regression for #137)",
  async () => {
    const kv = await setupKv();
    const handler = createHandler(createRouter());
    state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };

    // Need enough keys so 429-driven cooldown does not drain the pool before
    // the alternating sequence completes.
    for (let i = 0; i < 5; i++) {
      await addTestApiKey(`sk-upstream-test-${i}`);
    }

    let fetchCount = 0;
    const restoreFetch = installUpstreamResponse(() => {
      fetchCount += 1;
      const status = fetchCount % 2 === 1 ? 503 : 429;
      return new Response(JSON.stringify({ error: "x" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const expected = [503, 429, 503, 429, 503];
      for (const expectedStatus of expected) {
        const response = await handler(
          makeReq({ messages: [{ role: "user", content: "hi" }] }),
        );
        assertEquals(response.status, expectedStatus);
        await response.body?.cancel();
      }
      assertEquals(fetchCount, expected.length);

      const blocked = await handler(
        makeReq({ messages: [{ role: "user", content: "hi" }] }),
      );
      assertEquals(blocked.status, 503);
      assertEquals(blocked.headers.has("Retry-After"), true);
      const body = await blocked.json();
      assertEquals(body.error.code, "upstream_circuit_open");
      assertEquals(fetchCount, expected.length);
    } finally {
      setLogSinkForTests(null);
      restoreFetch();
      kv.close();
    }
  },
);

Deno.test(
  "proxy circuit: 2xx response closes the circuit (sanity check after #137)",
  async () => {
    const kv = await setupKv();
    const handler = createHandler(createRouter());
    state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
    await addTestApiKey("sk-upstream-test");

    let fetchCount = 0;
    const restoreFetch = installUpstreamResponse(() => {
      fetchCount += 1;
      if (fetchCount <= 2) {
        return new Response(JSON.stringify({ error: "x" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      for (let i = 0; i < 2; i++) {
        const response = await handler(
          makeReq({ messages: [{ role: "user", content: "hi" }] }),
        );
        assertEquals(response.status, 503);
        await response.body?.cancel();
      }
      assertEquals(state.upstreamCircuitFailureCount, 2);

      const ok = await handler(
        makeReq({ messages: [{ role: "user", content: "hi" }] }),
      );
      assertEquals(ok.status, 200);
      await ok.body?.cancel();
      assertEquals(state.upstreamCircuitFailureCount, 0);
      assertEquals(state.upstreamCircuitOpenedUntil, 0);
    } finally {
      setLogSinkForTests(null);
      restoreFetch();
      kv.close();
    }
  },
);
