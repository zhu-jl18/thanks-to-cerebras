/**
 * Regression tests for issue #138: cache refresh failures must not cascade into
 * proxy requests or produce a per-request KV retry storm.
 */

import { assertEquals } from "@std/assert";
import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  CEREBRAS_API_URL,
  PROXY_KEY_AUTH_REFRESH_INTERVAL_MS,
} from "../constants.ts";
import { createHandler, createRouter } from "../app.ts";
import { refreshApiKeyCacheIfChanged } from "../api-keys.ts";
import { createApiKeyStore } from "../kv/api-key-store.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

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

function sameKey(left: Deno.KvKey, right: readonly unknown[]): boolean {
  return left.length === right.length &&
    left.every((part, index) => part === right[index]);
}

function failRevisionReadsOnly(error: Error): {
  restore: () => void;
  callCount: () => number;
} {
  const original = state.kv;
  let count = 0;
  const proxy = new Proxy(original, {
    get(target, property) {
      if (property === "get") {
        return (key: Deno.KvKey, ...rest: unknown[]) => {
          if (sameKey(key, API_KEY_CACHE_REVISION_KEY)) {
            count++;
            return Promise.reject(error);
          }
          return (target.get as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>).call(target, key, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;
  state.kv = proxy;
  return {
    restore: () => {
      state.kv = original;
    },
    callCount: () => count,
  };
}

function isApiKeyRecordList(selector: Deno.KvListSelector): boolean {
  return "prefix" in selector && sameKey(selector.prefix, API_KEY_PREFIX);
}

function failApiKeyListOnly(error: Error): {
  restore: () => void;
  callCount: () => number;
} {
  const original = state.kv;
  let count = 0;
  const proxy = new Proxy(original, {
    get(target, property) {
      if (property === "list") {
        return (selector: Deno.KvListSelector, ...rest: unknown[]) => {
          if (isApiKeyRecordList(selector)) {
            count++;
            throw error;
          }
          return (target.list as unknown as (
            ...args: unknown[]
          ) => unknown).call(target, selector, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;
  state.kv = proxy;
  return {
    restore: () => {
      state.kv = original;
    },
    callCount: () => count,
  };
}

interface CapturedLog {
  level: string;
  record: Record<string, unknown>;
}

function captureLogs(): { records: CapturedLog[]; restore: () => void } {
  const records: CapturedLog[] = [];
  setLogSinkForTests((level, line) => {
    records.push({ level, record: JSON.parse(line) });
  });
  return {
    records,
    restore: () => setLogSinkForTests(null),
  };
}

Deno.test(
  "refreshApiKeyCacheIfChanged: persistent revision failure does not throw",
  async () => {
    const kv = await setupKv();
    await addTestApiKey("sk-test-cache");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      for (let index = 0; index < 5; index++) {
        await refreshApiKeyCacheIfChanged();
      }
      assertEquals(state.cachedActiveKeyIds.length, 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: throttle prevents revision retry storms",
  async () => {
    const kv = await setupKv();
    await addTestApiKey("sk-test-throttle");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      for (let index = 0; index < 100; index++) {
        await refreshApiKeyCacheIfChanged();
      }
      assertEquals(fail.callCount(), 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: concurrent failures share one revision read",
  async () => {
    const kv = await setupKv();
    await addTestApiKey("sk-test-concurrent");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      await Promise.all(
        Array.from({ length: 50 }, () => refreshApiKeyCacheIfChanged()),
      );
      assertEquals(fail.callCount(), 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: throttle re-arms after its window",
  async () => {
    const kv = await setupKv();
    await addTestApiKey("sk-test-rearm");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      await refreshApiKeyCacheIfChanged();
      assertEquals(fail.callCount(), 1);

      state.apiKeyCacheRevisionLastCheckedAt = Date.now() -
        PROXY_KEY_AUTH_REFRESH_INTERVAL_MS - 1;
      await refreshApiKeyCacheIfChanged();
      assertEquals(fail.callCount(), 2);
      await refreshApiKeyCacheIfChanged();
      assertEquals(fail.callCount(), 2);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "proxy request serves verified cache when revision read fails",
  async () => {
    const kv = await setupKv();
    const handler = createHandler(createRouter());
    state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
    await addTestApiKey("sk-upstream-cache-fallback");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
      assertEquals(String(input), CEREBRAS_API_URL);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      const response = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
      assertEquals(fail.callCount(), 1);
    } finally {
      globalThis.fetch = originalFetch;
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test("refresh recovers after a transient record-list failure", async () => {
  const kv = await setupKv();
  const id = await addTestApiKey("sk-retry-secret");
  const deleted = await createApiKeyStore(kv).delete(id);
  if (!deleted.ok) throw new Error(`delete failed: ${deleted.code}`);
  state.apiKeyCacheRevisionLastCheckedAt = 0;

  const fail = failApiKeyListOnly(new Error("transient list failure"));
  try {
    await refreshApiKeyCacheIfChanged();
    assertEquals(state.cachedKeysById.has(id), true);

    fail.restore();
    state.apiKeyCacheRevisionLastCheckedAt = 0;
    await refreshApiKeyCacheIfChanged();
    assertEquals(state.cachedKeysById.has(id), false);
  } finally {
    fail.restore();
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test(
  "refreshApiKeyCacheIfChanged: throttle prevents merge retry storms",
  async () => {
    const kv = await setupKv();
    await addTestApiKey("sk-test-list-throttle");
    await state.kv.set(API_KEY_CACHE_REVISION_KEY, Date.now() + 1);
    state.apiKeyCacheRevisionLastCheckedAt = 0;
    const fail = failApiKeyListOnly(new Error("kv list outage"));

    try {
      for (let index = 0; index < 100; index++) {
        await refreshApiKeyCacheIfChanged();
      }
      assertEquals(fail.callCount(), 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test("refresh failure logs phase=revision_read", async () => {
  const kv = await setupKv();
  await addTestApiKey("sk-test-log-revision");
  const logs = captureLogs();
  const fail = failRevisionReadsOnly(new Error("kv outage"));

  try {
    state.apiKeyCacheRevisionLastCheckedAt = 0;
    await refreshApiKeyCacheIfChanged();
    const warns = logs.records.filter((item) =>
      item.level === "warn" &&
      item.record.event === "api_key_cache_refresh_failed"
    );
    assertEquals(warns.length, 1);
    assertEquals(warns[0].record.phase, "revision_read");
    assertEquals(warns[0].record.errorMessage, "kv outage");
  } finally {
    fail.restore();
    logs.restore();
    kv.close();
  }
});

Deno.test("refresh failure logs phase=merge_keys", async () => {
  const kv = await setupKv();
  await addTestApiKey("sk-test-log-merge");
  await state.kv.set(API_KEY_CACHE_REVISION_KEY, Date.now() + 1);
  state.apiKeyCacheRevisionLastCheckedAt = 0;
  const logs = captureLogs();
  const fail = failApiKeyListOnly(new Error("kv list outage"));

  try {
    await refreshApiKeyCacheIfChanged();
    const warns = logs.records.filter((item) =>
      item.level === "warn" &&
      item.record.event === "api_key_cache_refresh_failed"
    );
    assertEquals(warns.length, 1);
    assertEquals(warns[0].record.phase, "merge_keys");
    assertEquals(warns[0].record.errorMessage, "kv list outage");
  } finally {
    fail.restore();
    logs.restore();
    kv.close();
  }
});