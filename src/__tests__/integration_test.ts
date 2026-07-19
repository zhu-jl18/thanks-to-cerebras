import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { AppState, state } from "../state.ts";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache, flushDirtyToKv } from "../kv/flush.ts";
import { createApiKeyStore } from "../kv/api-key-store.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { metrics } from "../metrics.ts";
import {
  ADMIN_CORS_HEADERS,
  ADMIN_TOKEN_PREFIX,
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  CEREBRAS_API_URL,
  CORS_HEADERS,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  DEFAULT_MODEL_POOL,
  MAX_PROXY_RESPONSE_BODY_BYTES,
  PROXY_KEY_PREFIX,
  PROXY_KEY_RATE_LIMIT_MAX,
  PROXY_KEY_RATE_LIMIT_WINDOW_MS,
  PROXY_KEY_STREAM_CONCURRENCY_MAX,
  PROXY_REQUEST_BODY_IDLE_TIMEOUT_MS,
  PROXY_UNAUTHORIZED_RATE_LIMIT_MAX,
} from "../constants.ts";
import { refreshApiKeyCacheIfChanged } from "../api-keys.ts";
import { hashProxyKey } from "../secrets.ts";
import {
  createAdminToken,
  isProxyAuthorized,
  verifyAdminToken,
} from "../auth.ts";
import { readBoundedTextForTests } from "../proxy-validation.ts";
import { setLogSinkForTests } from "../logger.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

const BASE = "http://localhost";

type Handler = (req: Request) => Promise<Response>;

function buildHandler(): Handler {
  return createHandler(createRouter());
}

function makeReq(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  return new Request(`${BASE}${path}`, init);
}

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
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

async function setupAuth(handler: Handler): Promise<string> {
  const res = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );
  const { token } = await res.json();
  return token;
}

async function enableProxyPublicAccess(handler: Handler): Promise<string> {
  const token = await setupAuth(handler);
  const res = await handler(
    makeReq("PATCH", "/api/config", {
      headers: { "X-Admin-Token": token },
      body: { proxyPublicAccess: true },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.proxyPublicAccess, true);
  return token;
}

async function addActiveApiKey(key: string): Promise<void> {
  await addTestApiKey(key);
}

function installUpstreamResponse(
  response: Response | (() => Response),
  expectedAuthorization = "Bearer sk-upstream-test",
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== CEREBRAS_API_URL) {
      throw new Error(`unexpected fetch input ${String(input)}`);
    }
    const authorization = new Headers(init?.headers).get("Authorization");
    if (authorization !== expectedAuthorization) {
      throw new Error("unexpected upstream authorization header");
    }
    return Promise.resolve(
      typeof response === "function" ? response() : response,
    );
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function requestBodyOf(size: number): string {
  const content = "x".repeat(size);
  return JSON.stringify({ messages: [{ role: "user", content }] });
}

// ─── Auth Flow ───

Deno.test("integration: auth setup → login → logout", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const status1 = await (await handler(
    makeReq("GET", "/api/auth/status"),
  )).json();
  assertEquals(status1.hasPassword, false);
  assertEquals(status1.isLoggedIn, false);

  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );
  assertEquals(setupRes.status, 200);
  const setupBody = await setupRes.json();
  assertEquals(setupBody.success, true);
  assertMatch(setupBody.token, /^[0-9a-f-]{36}$/);
  const setupToken = setupBody.token;

  const status2 = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": setupToken },
    }),
  )).json();
  assertEquals(status2.isLoggedIn, true);

  const dupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "other" },
    }),
  );
  assertEquals(dupRes.status, 400);

  const loginRes = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "test1234" } }),
  );
  assertEquals(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assertEquals(loginBody.success, true);
  assertMatch(loginBody.token, /^[0-9a-f-]{36}$/);
  const loginToken = loginBody.token;

  const loginStatus = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": loginToken },
    }),
  )).json();
  assertEquals(loginStatus.isLoggedIn, true);

  const badLogin = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "wrong" } }),
  );
  assertEquals(badLogin.status, 401);

  await handler(
    makeReq("POST", "/api/auth/logout", {
      headers: { "X-Admin-Token": loginToken },
    }),
  );
  const status3 = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": loginToken },
    }),
  )).json();
  assertEquals(status3.isLoggedIn, false);

  kv.close();
});

Deno.test("integration: admin session tokens are stored as keyed digests", async () => {
  const kv = await setupKv();

  const token = await createAdminToken();
  const plaintextEntry = await kv.get([...ADMIN_TOKEN_PREFIX, token]);
  assertEquals(plaintextEntry.value, null);
  await kv.set([...ADMIN_TOKEN_PREFIX, "legacy-token"], Date.now() + 60_000);
  assertEquals(await verifyAdminToken("legacy-token"), false);

  const digestEntry = await kv.get([
    ...ADMIN_TOKEN_PREFIX,
    await hashProxyKey(token),
  ]);
  assertEquals(typeof digestEntry.value, "number");
  assertEquals(await verifyAdminToken(token), true);

  kv.close();
});

Deno.test("integration: first-time auth setup requires JSON and bootstrap token", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  Deno.env.delete("SETUP_TOKEN");
  const missingEnv = await handler(
    makeReq("POST", "/api/auth/setup", { body: { password: "first-pass" } }),
  );
  assertEquals(missingEnv.status, 503);

  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  const missingHeader = await handler(
    makeReq("POST", "/api/auth/setup", {
      body: { password: "first-pass" },
    }),
  );
  assertEquals(missingHeader.status, 403);

  const wrongToken = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "wrong-token" },
      body: { password: "first-pass" },
    }),
  );
  assertEquals(wrongToken.status, 403);

  const wrongContentType = await handler(
    new Request(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Setup-Token": "test-setup-token",
      },
      body: JSON.stringify({ password: "first-pass" }),
    }),
  );
  assertEquals(wrongContentType.status, 415);

  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "first-pass" },
    }),
  );
  assertEquals(setupRes.status, 200);
  const body = await setupRes.json();
  assertEquals(body.success, true);
  assertMatch(body.token, /^[0-9a-f-]{36}$/);

  kv.close();
});

Deno.test("integration: login rejects non-JSON request bodies", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await setupAuth(handler);

  const res = await handler(
    new Request(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ password: "test1234" }),
    }),
  );
  assertEquals(res.status, 415);

  kv.close();
});

Deno.test("integration: concurrent first-time auth setup creates one admin token", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const responses = await Promise.all([
    handler(
      makeReq("POST", "/api/auth/setup", {
        headers: { "X-Setup-Token": "test-setup-token" },
        body: { password: "first-pass" },
      }),
    ),
    handler(
      makeReq("POST", "/api/auth/setup", {
        headers: { "X-Setup-Token": "wrong-token" },
        body: { password: "second-pass" },
      }),
    ),
  ]);
  const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
  assertEquals(statuses, [200, 403]);

  const bodies = await Promise.all(responses.map((res) => res.json()));
  const successBodies = bodies.filter((body) => body.success === true);
  assertEquals(successBodies.length, 1);
  assertMatch(successBodies[0].token, /^[0-9a-f-]{36}$/);

  kv.close();
});

Deno.test("integration: setup wrong-token requests do not consume rate-limit bucket", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  // Saturate the global admin-auth bucket (5 / 60s) using bogus
  // X-Setup-Token requests. With the cheap-checks-before-rate-limit
  // ordering these must NOT count toward the bucket, so the legitimate
  // setup that follows still succeeds.
  for (let i = 0; i < 20; i++) {
    const res = await handler(
      makeReq("POST", "/api/auth/setup", {
        headers: { "X-Setup-Token": `bogus-${i}` },
        body: { password: "first-pass" },
      }),
    );
    assertEquals(res.status, 403);
  }

  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "first-pass" },
    }),
  );
  assertEquals(setupRes.status, 200);

  kv.close();
});

Deno.test("integration: auth rate limit ignores spoofed forwarding headers", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );

  for (let i = 0; i < 4; i++) {
    const res = await handler(
      makeReq("POST", "/api/auth/login", {
        headers: { "x-forwarded-for": `203.0.113.${i}` },
        body: { password: "wrong" },
      }),
    );
    assertEquals(res.status, 401);
  }

  const limited = await handler(
    makeReq("POST", "/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.99" },
      body: { password: "wrong" },
    }),
  );
  assertEquals(limited.status, 429);

  kv.close();
});

Deno.test("integration: auth rate limit is stored in KV", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );

  for (let i = 0; i < 4; i++) {
    await handler(
      makeReq("POST", "/api/auth/login", { body: { password: "wrong" } }),
    );
  }

  const entries = [];
  for await (
    const entry of kv.list({
      prefix: ["cerebras-proxy", "rate-limit", "admin-auth"],
    })
  ) {
    entries.push(entry.value);
  }
  assertEquals(entries.length, 1);
  assertEquals((entries[0] as { count: number }).count, 5);

  kv.close();
});

// ─── Admin auth guard ───

Deno.test("integration: admin endpoints require auth", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/api/keys"));
  assertEquals(res.status, 401);

  kv.close();
});

// ─── API Key CRUD ───

Deno.test("integration: API key add → list → delete", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-test-abc123" },
    }),
  );
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const keyId = addBody.id;

  const dupRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-test-abc123" },
    }),
  );
  assertEquals(dupRes.status, 409);

  const listRes = await handler(makeReq("GET", "/api/keys", { headers: h }));
  assertEquals(listRes.status, 200);
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].id, keyId);
  assertEquals(listBody.keys[0].key, undefined);

  const storedApiKey = await kv.get([...API_KEY_PREFIX, keyId]);
  assertEquals((storedApiKey.value as { key?: string }).key, undefined);
  assertEquals(
    typeof (storedApiKey.value as { encryptedKey?: string }).encryptedKey,
    "string",
  );
  assertEquals(
    (storedApiKey.value as { encryptedKey: string }).encryptedKey.includes(
      "sk-test-abc123",
    ),
    false,
  );

  const exportRes = await handler(
    makeReq("GET", `/api/keys/${keyId}/export`, { headers: h }),
  );
  assertEquals(exportRes.status, 403);
  const delRes = await handler(
    makeReq("DELETE", `/api/keys/${keyId}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);

  const listRes2 = await handler(makeReq("GET", "/api/keys", { headers: h }));
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

Deno.test("integration: API key test errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-leak-test" },
    }),
  );
  const { id } = await addRes.json();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", `/api/keys/${id}/test`, {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.success, false);
    assertEquals(body.status, "inactive");
    assertEquals(body.error, "密钥测试失败");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

// ─── Proxy Key CRUD ───

Deno.test("integration: proxy key add → list → delete", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: h,
      body: { name: "Test Key" },
    }),
  );
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const pkId = addBody.id;
  const rawKey = addBody.key;
  assertMatch(rawKey, /^cpk_[A-Za-z0-9_-]+$/);

  const listRes = await handler(
    makeReq("GET", "/api/proxy-keys", { headers: h }),
  );
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].name, "Test Key");
  assertEquals(listBody.keys[0].key, undefined);

  const storedProxyKey = await kv.get([...PROXY_KEY_PREFIX, pkId]);
  assertEquals((storedProxyKey.value as { key?: string }).key, undefined);
  assertEquals(
    typeof (storedProxyKey.value as { keyHash?: string }).keyHash,
    "string",
  );
  assertEquals(
    (storedProxyKey.value as { keyHash: string }).keyHash.includes(rawKey),
    false,
  );

  const exportRes = await handler(
    makeReq("GET", `/api/proxy-keys/${pkId}/export`, { headers: h }),
  );
  assertEquals(exportRes.status, 403);

  const delRes = await handler(
    makeReq("DELETE", `/api/proxy-keys/${pkId}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);

  const listRes2 = await handler(
    makeReq("GET", "/api/proxy-keys", { headers: h }),
  );
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

Deno.test("integration: proxy auth refreshes stale cache after revocation revision", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  const addRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "revoked" },
    }),
  );
  const { id, key } = await addRes.json();
  state.proxyKeyCacheLastLoadedAt = 0;
  assertEquals(
    (await isProxyAuthorized(
      makeReq("POST", "/v1/chat/completions", {
        headers: { Authorization: `Bearer ${key}` },
      }),
    )).authorized,
    true,
  );

  await handler(
    makeReq("DELETE", `/api/proxy-keys/${id}`, {
      headers: { "X-Admin-Token": token },
    }),
  );
  if (!state.cachedProxyKeys) {
    throw new Error("proxy key cache not initialized");
  }
  state.cachedProxyKeys.set(id, {
    id,
    keyHash: await hashProxyKey(key),
    name: "stale",
    useCount: 0,
    createdAt: Date.now(),
  });
  state.proxyKeyCacheLastLoadedAt = 0;
  state.authCacheRevision = 0;
  state.authCacheRevisionLastCheckedAt = 0;

  const auth = await isProxyAuthorized(
    makeReq("POST", "/v1/chat/completions", {
      headers: { Authorization: `Bearer ${key}` },
    }),
  );
  assertEquals(auth.authorized, false);

  kv.close();
});

Deno.test("integration: proxy key list errors are structured", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalList = state.kv.list;
  state.kv.list = (() => {
    throw new Error("database password leaked");
  }) as typeof state.kv.list;

  try {
    const res = await handler(
      makeReq("GET", "/api/proxy-keys", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const body = await res.json();
    assertEquals(res.status, 500);
    assertEquals(body.detail, "获取代理密钥列表失败");
    assertEquals(
      JSON.stringify(body).includes("database password leaked"),
      false,
    );
  } finally {
    state.kv.list = originalList;
    kv.close();
  }
});

Deno.test("integration: legacy proxy keys migrate to hashed records", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const proxyKeyId = crypto.randomUUID();

  await kv.set([...PROXY_KEY_PREFIX, proxyKeyId], {
    id: proxyKeyId,
    key: "cpk_legacy_proxy",
    name: "legacy",
    useCount: 0,
    createdAt: 1,
  });

  const migrate = await handler(
    makeReq("POST", "/api/proxy-keys/migrate", {
      headers: { "X-Admin-Token": token },
    }),
  );
  assertEquals(migrate.status, 200);
  assertEquals((await migrate.json()).migrated, 1);

  const migrated = await kv.get([...PROXY_KEY_PREFIX, proxyKeyId]);
  assertEquals((migrated.value as { key?: string }).key, undefined);
  assertEquals(
    typeof (migrated.value as { keyHash?: string }).keyHash,
    "string",
  );
  kv.close();
});

Deno.test("integration: proxy key creation errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalAtomic = state.kv.atomic;
  state.kv.atomic = (() => {
    throw new Error("database password leaked");
  }) as typeof state.kv.atomic;

  try {
    const res = await handler(
      makeReq("POST", "/api/proxy-keys", {
        headers: { "X-Admin-Token": token },
        body: { name: "leak-check" },
      }),
    );
    const bodyText = await res.text();

    assertEquals(res.status, 400);
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    state.kv.atomic = originalAtomic;
    kv.close();
  }
});

// ─── Config ───

Deno.test("integration: config get → update", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const getRes = await handler(makeReq("GET", "/api/config", { headers: h }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(getBody.kvFlushIntervalMs, DEFAULT_KV_FLUSH_INTERVAL_MS);
  assertEquals(getBody.totalRequests, 0);
  assertEquals(getBody.proxyPublicAccess, false);

  const updateRes = await handler(
    makeReq("PATCH", "/api/config", {
      headers: h,
      body: { kvFlushIntervalMs: 5000, proxyPublicAccess: true },
    }),
  );
  assertEquals(updateRes.status, 200);
  const updateBody = await updateRes.json();
  assertEquals(updateBody.success, true);
  assertEquals(updateBody.kvFlushIntervalMs, 5000);
  assertEquals(updateBody.proxyPublicAccess, true);

  const persistedRes = await handler(
    makeReq("GET", "/api/config", { headers: h }),
  );
  assertEquals(persistedRes.status, 200);
  const persistedBody = await persistedRes.json();
  assertEquals(persistedBody.kvFlushIntervalMs, 5000);
  assertEquals(persistedBody.proxyPublicAccess, true);

  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
    state.kvFlushTimerId = null;
  }

  kv.close();
});

Deno.test("integration: dirty stats flush does not resurrect deleted API keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-race-delete-api" },
    }),
  );
  const { id } = await addRes.json();
  const cached = state.cachedKeysById.get(id);
  if (cached === undefined) throw new Error("added API key missing from cache");
  cached.useCount = 7;
  cached.lastUsed = 12345;
  state.dirtyKeyIds.add(id);

  const delRes = await handler(
    makeReq("DELETE", `/api/keys/${id}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);
  state.cachedKeysById.set(id, cached);
  state.dirtyKeyIds.add(id);

  await flushDirtyToKv();

  const entry = await state.kv.get([...API_KEY_PREFIX, id]);
  assertEquals(entry.value, null);

  kv.close();
});

Deno.test("integration: dirty stats flush does not resurrect deleted proxy keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: h,
      body: { name: "race delete" },
    }),
  );
  const { id } = await addRes.json();
  const cached = state.cachedProxyKeys!.get(id);
  if (cached === undefined) {
    throw new Error("added proxy key missing from cache");
  }
  cached.useCount = 4;
  cached.lastUsed = 12345;
  state.dirtyProxyKeyIds.add(id);

  const delRes = await handler(
    makeReq("DELETE", `/api/proxy-keys/${id}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);
  state.cachedProxyKeys!.set(id, cached);
  state.dirtyProxyKeyIds.add(id);

  await flushDirtyToKv();

  const entry = await state.kv.get([...PROXY_KEY_PREFIX, id]);
  assertEquals(entry.value, null);

  kv.close();
});

// ─── Stats ───

Deno.test("integration: stats endpoint", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-stat-test" },
    }),
  );

  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: h }),
  );
  assertEquals(statsRes.status, 200);
  const statsBody = await statsRes.json();
  assertEquals(statsBody.totalKeys, 1);
  assertEquals(statsBody.activeKeys, 1);

  kv.close();
});

// ─── Batch import ───

Deno.test("integration: batch import API keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const batchRes = await handler(
    makeReq("POST", "/api/keys/batch", {
      headers: h,
      body: { input: "sk-batch-1\nsk-batch-2\nsk-batch-3" },
    }),
  );
  assertEquals(batchRes.status, 200);
  const batchBody = await batchRes.json();
  assertEquals(batchBody.summary.total, 3);
  assertEquals(batchBody.summary.success, 3);
  assertEquals(batchBody.summary.failed, 0);

  const listRes = await handler(makeReq("GET", "/api/keys", { headers: h }));
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 3);

  kv.close();
});

// ─── Proxy authorization ───

Deno.test("integration: proxy 401 when no proxy key exists by default", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 401);

  kv.close();
});

Deno.test("integration: proxy explicit public mode allows requests without keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "没有可用的 API 密钥");

  kv.close();
});

Deno.test("integration: public access refreshes and retries after cache failures", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await enableProxyPublicAccess(handler);

  await handler(
    makeReq("PATCH", "/api/config", {
      headers: { "X-Admin-Token": token },
      body: { proxyPublicAccess: false },
    }),
  );
  state.cachedConfig!.proxyPublicAccess = true;
  state.proxyKeyCacheLastLoadedAt = 0;
  state.authCacheRevision = 0;
  state.authCacheRevisionLastCheckedAt = 0;

  const originalList = state.kv.list.bind(state.kv);
  let failed = false;
  state.kv.list = ((
    selector: Deno.KvListSelector,
    options?: Deno.KvListOptions,
  ) => {
    if (!failed) {
      failed = true;
      throw new Error("transient proxy key list failure");
    }
    return originalList(selector, options);
  }) as typeof state.kv.list;

  try {
    await assertRejects(
      () => isProxyAuthorized(makeReq("POST", "/v1/chat/completions")),
      Error,
      "transient proxy key list failure",
    );
    assertEquals(state.authCacheRevision, 0);
    assertEquals(state.authCacheRevisionLastCheckedAt, 0);
    state.kv.list = originalList;

    const auth = await isProxyAuthorized(
      makeReq("POST", "/v1/chat/completions"),
    );
    assertEquals(auth.authorized, false);
  } finally {
    state.kv.list = originalList;
    kv.close();
  }
});

Deno.test("integration: proxy invalid tokens do not repeatedly reload empty cache", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "gate" },
    }),
  );

  let listCalls = 0;
  const originalList = state.kv.list.bind(state.kv);
  state.kv.list = ((selector, options) => {
    const prefix = "prefix" in selector ? selector.prefix : null;
    if (
      Array.isArray(prefix) && prefix.join("/") === PROXY_KEY_PREFIX.join("/")
    ) {
      listCalls++;
    }
    return originalList(selector, options);
  }) as typeof state.kv.list;

  try {
    const responses = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        handler(
          makeReq("POST", "/v1/chat/completions", {
            headers: { Authorization: `Bearer invalid-token-${i}` },
            body: { messages: [{ role: "user", content: "hi" }] },
          }),
        )),
    );
    for (const res of responses) assertEquals(res.status, 401);
    assertEquals(listCalls, 0);
  } finally {
    state.kv.list = originalList;
    kv.close();
  }
});

Deno.test("integration: proxy 401 when proxy key exists but token missing", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  const addProxyKeyRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "gate" },
    }),
  );
  const addProxyKeyBody = await addProxyKeyRes.json();
  const rawProxyKey = addProxyKeyBody.key;

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 401);

  const resInvalid = await handler(
    makeReq("POST", "/v1/chat/completions", {
      headers: { Authorization: "Bearer invalid-token" },
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(resInvalid.status, 401);

  const resValid = await handler(
    makeReq("POST", "/v1/chat/completions", {
      headers: { Authorization: `Bearer ${rawProxyKey}` },
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(resValid.status, 500);

  kv.close();
});

// ─── Proxy: 400 bad request body ───

Deno.test("integration: proxy 400 when messages missing or empty", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res1 = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { not_messages: true },
    }),
  );
  assertEquals(res1.status, 400);

  const res2 = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [] },
    }),
  );
  assertEquals(res2.status, 400);

  kv.close();
});

Deno.test("integration: proxy rejects oversized Content-Length before JSON parsing", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res = await handler(
    new Request(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "2000000",
      },
      body: requestBodyOf(16),
    }),
  );
  assertEquals(res.status, 413);

  kv.close();
});

Deno.test("integration: proxy rejects oversized body without Content-Length", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res = await handler(
    new Request(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBodyOf(2000000),
    }),
  );
  assertEquals(res.status, 413);

  kv.close();
});

Deno.test("integration: proxy validates chat request schema and cost bounds", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const badRole = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "attacker", content: "hi" }] },
    }),
  );
  assertEquals(badRole.status, 400);

  const tooManyMessages = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: {
        messages: Array.from({ length: 65 }, () => ({
          role: "user",
          content: "hi",
        })),
      },
    }),
  );
  assertEquals(tooManyMessages.status, 400);

  const tooMuchContent = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "x".repeat(70000) }] },
    }),
  );
  assertEquals(tooMuchContent.status, 400);

  const tooManyOutputTokens = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8193,
      },
    }),
  );
  assertEquals(tooManyOutputTokens.status, 400);

  const nullOutputTokens = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: null,
      },
    }),
  );
  assertEquals(nullOutputTokens.status, 500);

  kv.close();
});

Deno.test("integration: upstream non-2xx errors are sanitized", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  const restoreFetch = installUpstreamResponse(
    new Response(JSON.stringify({ error: "account secret detail" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": "secret-trace",
        "Retry-After": "7",
      },
    }),
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    const text = await res.text();
    const body = JSON.parse(text);
    assertEquals(res.status, 401);
    assertEquals(body.error.message, "Upstream request failed");
    assertEquals(body.error.type, "upstream_error");
    assertEquals(body.error.param, null);
    assertEquals(body.error.code, "upstream_error");
    assertEquals(text.includes("account secret detail"), false);
    assertEquals(res.headers.get("X-Trace-Id"), null);
    assertEquals(res.headers.get("Retry-After"), "7");
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: upstream 401 invalidation does not persist plaintext API keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-invalidated-secret");
  const [apiKeyId] = state.cachedActiveKeyIds;
  const restoreFetch = installUpstreamResponse(
    new Response(JSON.stringify({ error: "revoked" }), { status: 401 }),
    "Bearer sk-invalidated-secret",
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    const text = await res.text();
    assertEquals(res.status, 401);
    assertEquals(text.includes("sk-invalidated-secret"), false);

    const entry = await kv.get([...API_KEY_PREFIX, apiKeyId]);
    const persisted = entry.value as Record<string, unknown>;
    assertEquals(persisted.status, "invalid");
    assertEquals(persisted.key, undefined);
    assertEquals(typeof persisted.encryptedKey, "string");
    assertEquals(
      JSON.stringify(persisted).includes("sk-invalidated-secret"),
      false,
    );
    const revisionEntry = await kv.get<number>(API_KEY_CACHE_REVISION_KEY);
    assertEquals(typeof revisionEntry.value, "number");
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: API key cache evicts stale deleted keys after revision", async () => {
  const kv = await setupKv();
  await addActiveApiKey("sk-stale-secret");
  const [apiKeyId] = state.cachedActiveKeyIds;

  const deleted = await createApiKeyStore(kv).delete(apiKeyId);
  if (!deleted.ok) throw new Error(`delete failed: ${deleted.code}`);
  state.apiKeyCacheRevision = 0;
  state.apiKeyCacheRevisionLastCheckedAt = 0;
  await refreshApiKeyCacheIfChanged();

  assertEquals(state.cachedKeysById.has(apiKeyId), false);
  assertEquals(state.cachedActiveKeyIds.includes(apiKeyId), false);

  kv.close();
});

Deno.test("integration: slow proxy request bodies are cancelled", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"messages":['));
    },
    cancel() {
      canceled = true;
    },
  });
  const startedAt = Date.now();

  try {
    const res = await handler(
      new Request(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    const responseBody = await res.json();
    assertEquals(res.status, 408);
    assertEquals(responseBody.error, "请求体读取超时");
    assertEquals(canceled, true);
    assertEquals(
      Date.now() - startedAt >= PROXY_REQUEST_BODY_IDLE_TIMEOUT_MS,
      true,
    );
  } finally {
    kv.close();
  }
});

Deno.test("readBoundedTextForTests - returns after cancelling a stalled body", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"messages":['));
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });

  const startedAt = Date.now();
  const result = await readBoundedTextForTests(
    new Request(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
    1024,
    { idleMs: 1, totalMs: 5 },
  );

  assertEquals(result, {
    ok: false,
    status: 408,
    message: "请求体读取超时",
  });
  assertEquals(canceled, true);
  assertEquals(Date.now() - startedAt < 1000, true);
});

Deno.test("integration: upstream model-not-found classification is bounded", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  let cancelCount = 0;
  const restoreFetch = installUpstreamResponse(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ error: { message: "model not found" } }),
            ),
          );
          controller.enqueue(new Uint8Array(MAX_PROXY_RESPONSE_BODY_BYTES));
        },
        cancel() {
          cancelCount++;
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    const text = await res.text();
    assertEquals(res.status, 404);
    assertEquals(text.includes("model not found"), false);
    assertEquals(text.includes("Upstream request failed"), true);
    assertEquals(cancelCount, 1);
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: non-model-not-found 404 returns sanitized error without upstream body", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  const secretBody = JSON.stringify({
    error: { message: "some internal upstream detail" },
  });
  const restoreFetch = installUpstreamResponse(
    new Response(secretBody, {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    const text = await res.text();
    assertEquals(res.status, 404);
    assertEquals(text.includes("Upstream request failed"), true);
    assertEquals(text.includes("some internal upstream detail"), false);
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: successful upstream stream is still passed through", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  const restoreFetch = installUpstreamResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    ),
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    assertEquals(await res.text(), "data: ok\n\n");
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: client cancellation releases stream slots", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  let upstreamCanceled = false;
  const restoreFetch = installUpstreamResponse(() =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: open\n\n"));
        },
        cancel() {
          upstreamCanceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(res.status, 200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("response body missing");
    const first = await reader.read();
    assertEquals(first.done, false);
    await reader.cancel("client disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(upstreamCanceled, true);
    const entries = [];
    for await (
      const entry of kv.list({ prefix: ["cerebras-proxy", "stream"] })
    ) {
      entries.push(entry);
    }
    assertEquals(entries.length, 0);
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: proxy stream response bytes are bounded", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  let upstreamCanceled = false;
  const restoreFetch = installUpstreamResponse(() =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_PROXY_RESPONSE_BODY_BYTES + 1));
        },
        cancel() {
          upstreamCanceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )
  );

  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(res.status, 200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("response body missing");
    await assertRejects(
      () => reader.read(),
      Error,
      "upstream stream body too large",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(upstreamCanceled, true);
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: proxy stream concurrency is limited per public bucket", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);
  await addActiveApiKey("sk-upstream-test");
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const restoreFetch = installUpstreamResponse(() =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: open\n\n"));
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )
  );

  try {
    for (let i = 0; i < PROXY_KEY_STREAM_CONCURRENCY_MAX; i++) {
      const res = await handler(
        makeReq("POST", "/v1/chat/completions", {
          body: { messages: [{ role: "user", content: "hi" }] },
        }),
      );
      assertEquals(res.status, 200);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("response body missing");
      await reader.read();
      readers.push(reader);
    }

    const limited = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.has("Retry-After"), true);
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel("done")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: proxy key rate limit returns Retry-After", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await addActiveApiKey("sk-upstream-test");
  const addProxyKeyRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "limited" },
    }),
  );
  const { key } = await addProxyKeyRes.json();
  const restoreFetch = installUpstreamResponse(
    () => new Response("ok", { status: 200 }),
  );

  try {
    for (let i = 0; i < PROXY_KEY_RATE_LIMIT_MAX; i++) {
      const res = await handler(
        makeReq("POST", "/v1/chat/completions", {
          headers: { Authorization: `Bearer ${key}` },
          body: { messages: [{ role: "user", content: "hi" }] },
        }),
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }

    const limited = await handler(
      makeReq("POST", "/v1/chat/completions", {
        headers: { Authorization: `Bearer ${key}` },
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.has("Retry-After"), true);
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: proxy key rate limit window resets", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await addActiveApiKey("sk-upstream-test");
  const addProxyKeyRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "reset" },
    }),
  );
  const { id, key } = await addProxyKeyRes.json();
  const restoreFetch = installUpstreamResponse(
    () => new Response("ok", { status: 200 }),
  );

  try {
    for (let i = 0; i < PROXY_KEY_RATE_LIMIT_MAX; i++) {
      const res = await handler(
        makeReq("POST", "/v1/chat/completions", {
          headers: { Authorization: `Bearer ${key}` },
          body: { messages: [{ role: "user", content: "hi" }] },
        }),
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }

    const expiredEntry = await kv.get([
      "cerebras-proxy",
      "rate-limit",
      "proxy-key",
      id,
    ]);
    assertEquals(expiredEntry.value !== null, true);
    await kv.set(expiredEntry.key, {
      count: PROXY_KEY_RATE_LIMIT_MAX,
      resetAt: Date.now() - PROXY_KEY_RATE_LIMIT_WINDOW_MS,
    });

    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        headers: { Authorization: `Bearer ${key}` },
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    restoreFetch();
    kv.close();
  }
});

Deno.test("integration: unauthorized proxy attempts are rate limited", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  for (let i = 0; i < PROXY_UNAUTHORIZED_RATE_LIMIT_MAX; i++) {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(res.status, 401);
  }

  const limited = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.has("Retry-After"), true);

  kv.close();
});

// ─── Proxy: 500 no API keys ───

Deno.test("integration: proxy 500 when no API keys available", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "没有可用的 API 密钥");

  kv.close();
});

// ─── Proxy: 429 all keys on cooldown ───

Deno.test("integration: proxy 429 when all API keys on cooldown", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await enableProxyPublicAccess(handler);

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-cooldown-test" },
    }),
  );
  const { id } = await addRes.json();

  state.keyCooldownUntil.set(id, Date.now() + 600_000);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 429);

  kv.close();
});

// ─── Proxy: 503 no models in pool ───

Deno.test("integration: proxy 503 when model pool is empty", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await enableProxyPublicAccess(handler);

  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-model-test" },
    }),
  );

  state.cachedModelPool = [];

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error, "没有可用的模型");

  kv.close();
});

// ─── Models: GET + PUT ───

Deno.test("integration: models GET and PUT", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const getRes = await handler(makeReq("GET", "/api/models", { headers: h }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(getBody.models, DEFAULT_MODEL_POOL);

  const putRes = await handler(
    makeReq("PUT", "/api/models", {
      headers: h,
      body: { models: ["test-model-a", "test-model-b"] },
    }),
  );
  assertEquals(putRes.status, 200);
  const putBody = await putRes.json();
  assertEquals(putBody.success, true);
  assertEquals(putBody.models, ["test-model-a", "test-model-b"]);

  const getRes2 = await handler(
    makeReq("GET", "/api/models", { headers: h }),
  );
  const getBody2 = await getRes2.json();
  assertEquals(getBody2.models, ["test-model-a", "test-model-b"]);

  const badPut = await handler(
    makeReq("PUT", "/api/models", {
      headers: h,
      body: { models: [] },
    }),
  );
  assertEquals(badPut.status, 400);

  kv.close();
});

Deno.test("integration: model availability errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-model-leak-test" },
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", "/api/models/cached-model/test", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.success, false);
    assertEquals(body.status, "error");
    assertEquals(body.error, "模型测试失败");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: model catalog errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("GET", "/api/models/catalog", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();

    assertEquals(res.status, 502);
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: stale model catalog errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  state.cachedModelCatalog = {
    source: "cerebras-public",
    fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
    models: ["cached-model"],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("GET", "/api/models/catalog", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.stale, true);
    assertEquals(body.lastError, "获取模型目录时发生错误");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: stale catalog refresh errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  state.cachedModelCatalog = {
    source: "cerebras-public",
    fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
    models: ["cached-model"],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", "/api/models/catalog/refresh", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.stale, true);
    assertEquals(body.lastError, "刷新模型目录时发生错误");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: catalog refresh errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", "/api/models/catalog/refresh", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();

    assertEquals(res.status, 502);
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

// ─── CORS: OPTIONS preflight ───

Deno.test("integration: OPTIONS returns correct CORS headers", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const proxyOpts = await handler(makeReq("OPTIONS", "/v1/chat/completions"));
  assertEquals(proxyOpts.status, 204);
  assertEquals(
    proxyOpts.headers.get("Access-Control-Allow-Origin"),
    CORS_HEADERS["Access-Control-Allow-Origin"],
  );
  assertEquals(
    proxyOpts.headers.get("Access-Control-Allow-Methods"),
    CORS_HEADERS["Access-Control-Allow-Methods"],
  );

  const adminOpts = await handler(makeReq("OPTIONS", "/api/keys"));
  assertEquals(adminOpts.status, 204);
  assertEquals(adminOpts.headers.has("Access-Control-Allow-Origin"), false);
  assertEquals(
    adminOpts.headers.get("Access-Control-Allow-Methods"),
    ADMIN_CORS_HEADERS["Access-Control-Allow-Methods"],
  );

  kv.close();
});

Deno.test("integration: admin JSON responses do not expose open CORS", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );
  assertEquals(setupRes.headers.has("Access-Control-Allow-Origin"), false);

  const { token } = await setupRes.json();
  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: { "X-Admin-Token": token } }),
  );
  assertEquals(statsRes.status, 200);
  assertEquals(statsRes.headers.has("Access-Control-Allow-Origin"), false);

  const modelsRes = await handler(makeReq("GET", "/v1/models"));
  assertEquals(modelsRes.status, 200);
  assertEquals(
    modelsRes.headers.get("Access-Control-Allow-Origin"),
    CORS_HEADERS["Access-Control-Allow-Origin"],
  );

  kv.close();
});

Deno.test("integration: unauthenticated root HTML contains no KV-derived stats", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-root-stats" },
    }),
  );

  const res = await handler(makeReq("GET", "/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'id="statTotalKeys">—</div>');
  assertStringIncludes(html, 'id="statActiveKeys">—</div>');
  assertStringIncludes(html, 'id="statTotalRequests">—</div>');
  assertStringIncludes(
    html,
    'id="authBadge" class="auth-badge auth-unknown">登录后加载</span>',
  );
  assertStringIncludes(html, 'id="keyCountLabel">—/');
  assertEquals(html.includes("sk-root-stats"), false);
  assertEquals(
    html.includes('id="authBadge" class="auth-badge auth-on"'),
    false,
  );
  assertEquals(
    html.includes('id="authBadge" class="auth-badge auth-off"'),
    false,
  );

  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: { "X-Admin-Token": token } }),
  );
  const stats = await statsRes.json();
  assertEquals(stats.totalKeys, 1);
  assertEquals(stats.activeKeys, 1);

  kv.close();
});

// ─── Healthz ───

Deno.test("integration: GET /healthz returns 200", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");

  kv.close();
});

// ─── 404 ───

Deno.test("integration: unknown path returns 404", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/nonexistent"));
  assertEquals(res.status, 404);

  kv.close();
});

// ─── Metrics ───

Deno.test("integration: /api/metrics returns counters (requires auth)", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await handler(
    makeReq("PATCH", "/api/config", {
      headers: { "X-Admin-Token": token },
      body: { proxyPublicAccess: true },
    }),
  );

  const proxyRes = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(proxyRes.status, 500);

  const res = await handler(
    makeReq("GET", "/api/metrics", {
      headers: { "X-Admin-Token": token },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.proxy_requests_total.no_key, 1);

  const noAuth = await handler(makeReq("GET", "/api/metrics"));
  assertEquals(noAuth.status, 401);

  kv.close();
});
