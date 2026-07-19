// API URLs
export const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
export const CEREBRAS_PUBLIC_MODELS_URL =
  "https://api.cerebras.ai/public/v1/models";

// KV storage keys
export const KV_PREFIX = "cerebras-proxy";
export const CONFIG_KEY = [KV_PREFIX, "meta", "config"] as const;
export const MODEL_CATALOG_KEY = [KV_PREFIX, "meta", "model_catalog"] as const;
export const API_KEY_PREFIX = [KV_PREFIX, "keys", "api"] as const;
// Unique claim keyed by a versioned HMAC fingerprint of the plaintext API key.
// The claim is created and deleted atomically with its record, providing the
// Deno KV equivalent of a UNIQUE(fingerprint) constraint.
export const API_KEY_UNIQUE_PREFIX = [
  KV_PREFIX,
  "keys",
  "api_unique",
  "v1",
] as const;
export const PROXY_KEY_PREFIX = [KV_PREFIX, "keys", "proxy"] as const;
export const ADMIN_PASSWORD_KEY = [
  KV_PREFIX,
  "meta",
  "admin_password",
] as const;
export const ADMIN_TOKEN_PREFIX = [KV_PREFIX, "auth", "token"] as const;
export const AUTH_CACHE_REVISION_KEY = [
  KV_PREFIX,
  "meta",
  "auth_cache_revision",
] as const;
export const API_KEY_CACHE_REVISION_KEY = [
  KV_PREFIX,
  "meta",
  "api_key_cache_revision",
] as const;

// Retry and limits
export const KV_ATOMIC_MAX_RETRIES = 10;
export const MAX_PROXY_KEYS = 5;
export const MAX_MODEL_NOT_FOUND_RETRIES = 3;
export const UPSTREAM_CIRCUIT_FAILURE_THRESHOLD = 3;
export const UPSTREAM_CIRCUIT_OPEN_MS = 30_000;
export const PROXY_KEY_AUTH_REFRESH_INTERVAL_MS = 5000;
export const MAX_PROXY_REQUEST_BODY_BYTES = 256 * 1024;
export const PROXY_REQUEST_BODY_IDLE_TIMEOUT_MS = 10_000;
export const PROXY_REQUEST_BODY_TOTAL_TIMEOUT_MS = 30_000;
export const MAX_CHAT_MESSAGES = 64;
export const MAX_CHAT_MESSAGE_CONTENT_CHARS = 16_000;
export const MAX_CHAT_TOTAL_CONTENT_CHARS = 64_000;
export const MAX_CHAT_COMPLETION_TOKENS = 8192;
export const MAX_UPSTREAM_ERROR_BODY_BYTES = 4096;
export const UPSTREAM_ERROR_BODY_TIMEOUT_MS = 5000;
export const ADMIN_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
export const ADMIN_AUTH_RATE_LIMIT_MAX = 5;
export const PROXY_GLOBAL_RATE_LIMIT_WINDOW_MS = 60_000;
export const PROXY_GLOBAL_RATE_LIMIT_MAX = 120;
export const PROXY_KEY_RATE_LIMIT_WINDOW_MS = 60_000;
export const PROXY_KEY_RATE_LIMIT_MAX = 60;
export const PROXY_UNAUTHORIZED_RATE_LIMIT_WINDOW_MS = 60_000;
export const PROXY_UNAUTHORIZED_RATE_LIMIT_MAX = 20;
export const MAX_PROXY_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
export const PROXY_STREAM_TOTAL_TIMEOUT_MS = 5 * 60_000;
export const PROXY_STREAM_IDLE_TIMEOUT_MS = 30_000;
export const PROXY_STREAM_SLOT_LEASE_MS = PROXY_STREAM_TOTAL_TIMEOUT_MS +
  10_000;
export const PROXY_GLOBAL_STREAM_CONCURRENCY_MAX = 8;
export const PROXY_KEY_STREAM_CONCURRENCY_MAX = 4;

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

// HTTP headers — proxy endpoints (open CORS for browser extensions etc.)
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Admin endpoints — same-origin only (no Access-Control-Allow-Origin)
export const ADMIN_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PUT, PATCH",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};
