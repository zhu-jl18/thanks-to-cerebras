import { assertEquals } from "@std/assert";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { forwardChatCompletion } from "../services/proxy.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { logger, type LogLevel, setLogSinkForTests } from "../logger.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

const BASE = "http://localhost";

function makeReq(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, { method, headers });
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
  return kv;
}

Deno.test(
  "app: responses include request IDs and structured request logs",
  async () => {
    const logs: Array<{ level: LogLevel; line: string }> = [];
    setLogSinkForTests((level, line) => logs.push({ level, line }));
    const handler = createHandler(createRouter());

    try {
      const providedId = "req-test-123";
      const echoed = await handler(
        makeReq("GET", "/healthz", { "X-Request-Id": providedId }),
      );
      assertEquals(echoed.headers.get("x-request-id"), providedId);

      const generated = await handler(makeReq("GET", "/v1/models"));
      const generatedId = generated.headers.get("x-request-id");
      assertEquals(typeof generatedId, "string");
      assertEquals(generatedId === providedId, false);

      const records = logs.map(({ line }) => JSON.parse(line));
      const echoedLog = records.find((record) =>
        record.requestId === providedId
      );
      if (!echoedLog) throw new Error("missing echoed request log");
      assertEquals(echoedLog.level, "info");
      assertEquals(echoedLog.event, "http_request");
      assertEquals(echoedLog.method, "GET");
      assertEquals(echoedLog.path, "/healthz");
      assertEquals(echoedLog.status, 200);

      const oversizedId = "r".repeat(129);
      const sanitized = await handler(
        makeReq("GET", "/healthz", { "X-Request-Id": oversizedId }),
      );
      assertEquals(
        sanitized.headers.get("x-request-id") === oversizedId,
        false,
      );

      const generatedLog = records.find((record) =>
        record.requestId === generatedId
      );
      if (!generatedLog) throw new Error("missing generated request log");
      assertEquals(generatedLog.event, "http_request");
      assertEquals(generatedLog.path, "/v1/models");
    } finally {
      setLogSinkForTests(null);
    }
  },
);

Deno.test(
  "logger: error details are sanitized, truncated, and include stack",
  () => {
    const logs: Array<{ level: LogLevel; line: string }> = [];
    setLogSinkForTests((level, line) => logs.push({ level, line }));

    try {
      const error = new Error(
        `Authorization: Bearer secret-token api_key=plain secret=${
          "x".repeat(1200)
        }`,
      );
      error.stack = `Error: ${error.message}\nat test@example.com`;
      logger.error("test_error", {
        requestId: "req-log-test",
        token: "Bearer field-secret-token",
      }, error);

      const record = JSON.parse(logs[0].line);
      const serialized = JSON.stringify(record);
      assertEquals(record.level, "error");
      assertEquals(record.event, "test_error");
      assertEquals(record.requestId, "req-log-test");
      assertEquals(typeof record.errorStack, "string");
      assertEquals(serialized.includes("secret-token"), false);
      assertEquals(serialized.includes("field-secret-token"), false);
      assertEquals(serialized.includes("test@example.com"), false);
      assertEquals(record.errorMessage.length <= 1000, true);
    } finally {
      setLogSinkForTests(null);
    }
  },
);

Deno.test("proxy: upstream fetch failure logs request ID", async () => {
  const kv = await setupKv();
  const logs: Array<{ level: LogLevel; line: string }> = [];
  const originalFetch = globalThis.fetch;
  setLogSinkForTests((level, line) => logs.push({ level, line }));
  await addTestApiKey("sk-upstream-test");
  globalThis.fetch = () => {
    throw new Error("network Authorization: Bearer leaked-token");
  };

  try {
    const result = await forwardChatCompletion({
      messages: [{ role: "user", content: "hi" }],
    }, { requestId: "req-proxy-log" });
    assertEquals(result.kind, "error");
    assertEquals(result.status, 502);

    const records = logs.map(({ line }) => JSON.parse(line));
    const upstreamLog = records.find((record) =>
      record.event === "proxy_upstream_fetch_failed"
    );
    if (!upstreamLog) throw new Error("missing upstream failure log");
    assertEquals(upstreamLog.requestId, "req-proxy-log");
    assertEquals(upstreamLog.level, "error");
    assertEquals(typeof upstreamLog.errorStack, "string");
    assertEquals(JSON.stringify(upstreamLog).includes("leaked-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    setLogSinkForTests(null);
    kv.close();
  }
});
