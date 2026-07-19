function replaceExactlyOnce(
  source: string,
  before: string,
  after: string,
  label: string,
): string {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${label}: expected one match, found ${occurrences}`);
  }
  return source.replace(before, after);
}

const integrationPath = "src/__tests__/integration_test.ts";
let integration = await Deno.readTextFile(integrationPath);

integration = replaceExactlyOnce(
  integration,
  `import {
  rebuildActiveKeyIds,
  refreshApiKeyCacheIfChanged,
} from "../api-keys.ts";
import { encryptApiKey, hashProxyKey } from "../secrets.ts";`,
  `import { refreshApiKeyCacheIfChanged } from "../api-keys.ts";
import { hashProxyKey } from "../secrets.ts";`,
  "integration imports",
);

integration = replaceExactlyOnce(
  integration,
  `import { setLogSinkForTests } from "../logger.ts";
const BASE = "http://localhost";`,
  `import { setLogSinkForTests } from "../logger.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

const BASE = "http://localhost";`,
  "integration test helper import",
);

integration = replaceExactlyOnce(
  integration,
  `async function addActiveApiKey(key: string): Promise<void> {
  const apiKey = {
    id: crypto.randomUUID(),
    key,
    encryptedKey: await encryptApiKey(key),
    useCount: 0,
    status: "active" as const,
    createdAt: Date.now(),
  };
  await state.kv.set([...API_KEY_PREFIX, apiKey.id], {
    id: apiKey.id,
    encryptedKey: apiKey.encryptedKey,
    useCount: apiKey.useCount,
    status: apiKey.status,
    createdAt: apiKey.createdAt,
  });
  state.cachedKeysById.set(apiKey.id, apiKey);
  rebuildActiveKeyIds();
}`,
  `async function addActiveApiKey(key: string): Promise<void> {
  await addTestApiKey(key);
}`,
  "integration API-key fixture",
);

integration = replaceExactlyOnce(
  integration,
  `Deno.test("integration: legacy stored keys migrate to encrypted records", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };
  const apiKeyId = crypto.randomUUID();
  const proxyKeyId = crypto.randomUUID();

  await kv.set([...API_KEY_PREFIX, apiKeyId], {
    id: apiKeyId,
    key: "sk-legacy-api",
    useCount: 0,
    status: "active",
    createdAt: 1,
  });
  await kv.set([...PROXY_KEY_PREFIX, proxyKeyId], {
    id: proxyKeyId,
    key: "cpk_legacy_proxy",
    name: "legacy",
    useCount: 0,
    createdAt: 1,
  });

  const apiMigrate = await handler(
    makeReq("POST", "/api/keys/migrate", { headers: h }),
  );
  assertEquals(apiMigrate.status, 200);
  assertEquals((await apiMigrate.json()).migrated, 1);
  const proxyMigrate = await handler(
    makeReq("POST", "/api/proxy-keys/migrate", { headers: h }),
  );
  assertEquals(proxyMigrate.status, 200);
  assertEquals((await proxyMigrate.json()).migrated, 1);

  const migratedApiKey = await kv.get([...API_KEY_PREFIX, apiKeyId]);
  assertEquals((migratedApiKey.value as { key?: string }).key, undefined);
  assertEquals(
    typeof (migratedApiKey.value as { encryptedKey?: string }).encryptedKey,
    "string",
  );
  const migratedProxyKey = await kv.get([...PROXY_KEY_PREFIX, proxyKeyId]);
  assertEquals((migratedProxyKey.value as { key?: string }).key, undefined);
  assertEquals(
    typeof (migratedProxyKey.value as { keyHash?: string }).keyHash,
    "string",
  );

  const restoreFetch = installUpstreamResponse(
    new Response("ok", { status: 200 }),
    "Bearer sk-legacy-api",
  );
  try {
    const res = await handler(
      makeReq("POST", "/v1/chat/completions", {
        headers: { Authorization: "Bearer cpk_legacy_proxy" },
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    restoreFetch();
    kv.close();
  }
});`,
  `Deno.test("integration: legacy proxy keys migrate to hashed records", async () => {
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
});`,
  "integration legacy migration test",
);

await Deno.writeTextFile(integrationPath, integration);

const openApiPath = "docs/openapi.json";
let openApi = await Deno.readTextFile(openApiPath);
openApi = replaceExactlyOnce(
  openApi,
  `    "/api/keys/migrate": {
      "post": {
        "tags": ["Admin keys"],
        "operationId": "migrateApiKeys",
        "summary": "Migrate stored Cerebras API keys to encrypted storage",
        "security": [{ "AdminToken": [] }],
        "responses": {
          "200": { "$ref": "#/components/responses/Migrated" },
          "401": { "$ref": "#/components/responses/Problem" }
        }
      }
    },
`,
  "",
  "OpenAPI API-key migration path",
);

openApi = replaceExactlyOnce(
  openApi,
  `        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "400": { "$ref": "#/components/responses/Problem" },
          "401": { "$ref": "#/components/responses/Problem" },
          "404": { "$ref": "#/components/responses/Problem" }
        }
      }
    },
    "/api/keys/{id}/export":`,
  `        "responses": {
          "200": { "$ref": "#/components/responses/Success" },
          "401": { "$ref": "#/components/responses/Problem" },
          "404": { "$ref": "#/components/responses/Problem" },
          "409": { "$ref": "#/components/responses/Problem" },
          "500": { "$ref": "#/components/responses/Problem" }
        }
      }
    },
    "/api/keys/{id}/export":`,
  "OpenAPI API-key delete responses",
);
await Deno.writeTextFile(openApiPath, openApi);