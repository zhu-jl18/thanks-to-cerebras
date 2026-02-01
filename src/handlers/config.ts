import { MIN_KV_FLUSH_INTERVAL_MS } from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import {
  getErrorMessage,
  maskKey,
  normalizeKvFlushIntervalMs,
} from "../utils.ts";
import { kvFlushIntervalMsEffective } from "../state.ts";
import {
  applyKvFlushInterval,
  kvGetAllKeys,
  kvGetConfig,
  kvUpdateConfig,
  resolveKvFlushIntervalMs,
} from "../kv.ts";

export async function handleConfigRoutes(
  req: Request,
  path: string,
): Promise<Response | null> {
  if (req.method === "GET" && path === "/api/stats") {
    const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
    const stats = {
      totalKeys: keys.length,
      activeKeys: keys.filter((k) => k.status === "active").length,
      totalRequests: config.totalRequests,
      keyUsage: keys.map((k) => ({
        id: k.id,
        maskedKey: maskKey(k.key),
        useCount: k.useCount,
        status: k.status,
      })),
    };
    return jsonResponse(stats);
  }

  if (req.method === "PATCH" && path === "/api/config") {
    try {
      const body = await req.json().catch(() => ({}));
      const raw = body.kvFlushIntervalMs;

      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return problemResponse("kvFlushIntervalMs 必须为数字", {
          status: 400,
          instance: path,
        });
      }

      const normalized = normalizeKvFlushIntervalMs(raw);
      const next = await kvUpdateConfig((config) => ({
        ...config,
        kvFlushIntervalMs: normalized,
      }));

      applyKvFlushInterval(next);

      return jsonResponse({
        success: true,
        kvFlushIntervalMs: normalized,
        effectiveKvFlushIntervalMs: kvFlushIntervalMsEffective,
        kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path,
      });
    }
  }

  if (req.method === "GET" && path === "/api/config") {
    const config = await kvGetConfig();
    const configured = normalizeKvFlushIntervalMs(
      config.kvFlushIntervalMs ?? MIN_KV_FLUSH_INTERVAL_MS,
    );

    const effective = resolveKvFlushIntervalMs({
      ...config,
      kvFlushIntervalMs: configured,
    });

    return jsonResponse({
      ...config,
      kvFlushIntervalMs: configured,
      effectiveKvFlushIntervalMs: effective,
      kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
    });
  }

  return null;
}
