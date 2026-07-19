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

const path = "src/__tests__/integration_test.ts";
let source = await Deno.readTextFile(path);
source = replaceExactlyOnce(
  source,
  `import { bootstrapCache, flushDirtyToKv } from "../kv/flush.ts";`,
  `import { bootstrapCache, flushDirtyToKv } from "../kv/flush.ts";
import { createApiKeyStore } from "../kv/api-key-store.ts";`,
  "integration store import",
);
source = replaceExactlyOnce(
  source,
  `  await kv.delete([...API_KEY_PREFIX, apiKeyId]);
  await kv.set(API_KEY_CACHE_REVISION_KEY, Date.now());
  state.apiKeyCacheRevision = 0;`,
  `  const deleted = await createApiKeyStore(kv).delete(apiKeyId);
  if (!deleted.ok) throw new Error(\`delete failed: \${deleted.code}\`);
  state.apiKeyCacheRevision = 0;`,
  "integration atomic delete",
);
await Deno.writeTextFile(path, source);