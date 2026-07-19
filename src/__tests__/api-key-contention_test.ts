import { assertEquals } from "@std/assert";
import {
  API_KEY_PREFIX,
  KV_ATOMIC_MAX_RETRIES,
  PROXY_KEY_AUTH_REFRESH_INTERVAL_MS,
} from "../constants.ts";
import {
  apiKeyUniqueClaimKey,
  createApiKeyStore,
} from "../kv/api-key-store.ts";
import { setLogSinkForTests } from "../logger.ts";
import { metrics } from "../metrics.ts";
import { fingerprintApiKey } from "../secrets.ts";
import { selectProxyApiKey } from "../services/proxy-api-key.ts";
import { AppState, state } from "../state.ts";
import { addTestApiKey } from "./api-key-test-helpers.ts";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  metrics.reset();
  setLogSinkForTests(() => {});
  return kv;
}

function sameKey(left: Deno.KvKey, right: readonly unknown[]): boolean {
  return left.length === right.length &&
    left.every((part, index) => part === right[index]);
}

function countApiKeyRecordScans(): {
  count: () => number;
  restore: () => void;
} {
  const original = state.kv;
  let count = 0;
  state.kv = new Proxy(original, {
    get(target, property) {
      if (property === "list") {
        return (selector: Deno.KvListSelector, ...rest: unknown[]) => {
          if (
            "prefix" in selector && sameKey(selector.prefix, API_KEY_PREFIX)
          ) {
            count++;
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

  return {
    count: () => count,
    restore: () => {
      state.kv = original;
    },
  };
}

Deno.test(
  "selectProxyApiKey: empty-pool verification is bounded by the refresh interval",
  async () => {
    const kv = await setupKv();
    const scans = countApiKeyRecordScans();
    state.apiKeyCacheRevisionLastCheckedAt = 0;

    try {
      for (let index = 0; index < 20; index++) {
        const selection = await selectProxyApiKey({});
        assertEquals(selection.ok, false);
        if (!selection.ok) assertEquals(selection.status, 500);
      }
      assertEquals(scans.count(), 1);
    } finally {
      scans.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "selectProxyApiKey: cooldown-only exhaustion does not force a full store scan",
  async () => {
    const kv = await setupKv();
    const id = await addTestApiKey("sk-cooldown-no-scan");
    state.keyCooldownUntil.set(id, Date.now() + 60_000);
    state.apiKeyCacheRevisionLastCheckedAt = Date.now() -
      PROXY_KEY_AUTH_REFRESH_INTERVAL_MS - 1;
    const scans = countApiKeyRecordScans();

    try {
      const selection = await selectProxyApiKey({});
      assertEquals(selection.ok, false);
      if (!selection.ok) assertEquals(selection.status, 429);
      assertEquals(scans.count(), 0);
    } finally {
      scans.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "ApiKeyStore.create: final claim winner is reported as a duplicate",
  async () => {
    const kv = await setupKv();
    const plaintext = "sk-final-claim-race";
    const claimKey = apiKeyUniqueClaimKey(await fingerprintApiKey(plaintext));
    const originalAtomic = kv.atomic.bind(kv);
    let commitCount = 0;

    kv.atomic = () => {
      const operation = originalAtomic();
      operation.commit = async () => {
        commitCount++;
        if (commitCount === KV_ATOMIC_MAX_RETRIES) {
          await kv.set(claimKey, "concurrent-winner");
        }
        return { ok: false } as unknown as Deno.KvCommitResult;
      };
      return operation;
    };

    try {
      assertEquals(await createApiKeyStore(kv).create(plaintext), {
        ok: false,
        code: "duplicate",
      });
      assertEquals(commitCount, KV_ATOMIC_MAX_RETRIES);
    } finally {
      kv.atomic = originalAtomic;
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
