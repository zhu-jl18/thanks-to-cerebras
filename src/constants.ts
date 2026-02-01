// API URLs
export const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
export const CEREBRAS_PUBLIC_MODELS_URL =
  "https://api.cerebras.ai/public/v1/models";

// KV storage keys
export const KV_PREFIX = "cerebras-proxy";
export const CONFIG_KEY = [KV_PREFIX, "meta", "config"] as const;
export const MODEL_CATALOG_KEY = [KV_PREFIX, "meta", "model_catalog"] as const;
export const API_KEY_PREFIX = [KV_PREFIX, "keys", "api"] as const;
export const PROXY_KEY_PREFIX = [KV_PREFIX, "keys", "proxy"] as const;
export const ADMIN_PASSWORD_KEY = [KV_PREFIX, "meta", "admin_password"] as const;
export const ADMIN_TOKEN_PREFIX = [KV_PREFIX, "auth", "token"] as const;

// Retry and limits
export const KV_ATOMIC_MAX_RETRIES = 10;
export const MAX_PROXY_KEYS = 5;
export const MAX_MODEL_NOT_FOUND_RETRIES = 3;

// Timeouts
export const ADMIN_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const UPSTREAM_TEST_TIMEOUT_MS = 12000;
export const PROXY_REQUEST_TIMEOUT_MS = 60000;
export const DEFAULT_KV_FLUSH_INTERVAL_MS = 15000;
export const MIN_KV_FLUSH_INTERVAL_MS = 1000;
export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 8000;

// Default model configuration
export const DEFAULT_MODEL_POOL = [
  "gpt-oss-120b",
  "qwen-3-235b-a22b-instruct-2507",
  "zai-glm-4.7",
];
export const FALLBACK_MODEL = "qwen-3-235b-a22b-instruct-2507";
export const EXTERNAL_MODEL_ID = "cerebras-translator";

// HTTP headers
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
};

export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};
