// deno:https://deno.land/std@0.208.0/async/delay.ts
function delay(ms, options = {}) {
  const { signal, persistent } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(i);
      reject(signal?.reason);
    };
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const i = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, {
      once: true
    });
    if (persistent === false) {
      try {
        Deno.unrefTimer(i);
      } catch (error) {
        if (!(error instanceof ReferenceError)) {
          throw error;
        }
        console.error("`persistent` option is only available in Deno");
      }
    }
  });
}

// deno:https://deno.land/std@0.208.0/http/server.ts
var ERROR_SERVER_CLOSED = "Server closed";
var HTTP_PORT = 80;
var HTTPS_PORT = 443;
var INITIAL_ACCEPT_BACKOFF_DELAY = 5;
var MAX_ACCEPT_BACKOFF_DELAY = 1e3;
var Server = class {
  #port;
  #host;
  #handler;
  #closed = false;
  #listeners = /* @__PURE__ */ new Set();
  #acceptBackoffDelayAbortController = new AbortController();
  #httpConnections = /* @__PURE__ */ new Set();
  #onError;
  /**
   * Constructs a new HTTP Server instance.
   *
   * ```ts
   * import { Server } from "https://deno.land/std@$STD_VERSION/http/server.ts";
   *
   * const port = 4505;
   * const handler = (request: Request) => {
   *   const body = `Your user-agent is:\n\n${request.headers.get(
   *    "user-agent",
   *   ) ?? "Unknown"}`;
   *
   *   return new Response(body, { status: 200 });
   * };
   *
   * const server = new Server({ port, handler });
   * ```
   *
   * @param serverInit Options for running an HTTP server.
   */
  constructor(serverInit) {
    this.#port = serverInit.port;
    this.#host = serverInit.hostname;
    this.#handler = serverInit.handler;
    this.#onError = serverInit.onError ?? function(error) {
      console.error(error);
      return new Response("Internal Server Error", {
        status: 500
      });
    };
  }
  /**
   * Accept incoming connections on the given listener, and handle requests on
   * these connections with the given handler.
   *
   * HTTP/2 support is only enabled if the provided Deno.Listener returns TLS
   * connections and was configured with "h2" in the ALPN protocols.
   *
   * Throws a server closed error if called after the server has been closed.
   *
   * Will always close the created listener.
   *
   * ```ts
   * import { Server } from "https://deno.land/std@$STD_VERSION/http/server.ts";
   *
   * const handler = (request: Request) => {
   *   const body = `Your user-agent is:\n\n${request.headers.get(
   *    "user-agent",
   *   ) ?? "Unknown"}`;
   *
   *   return new Response(body, { status: 200 });
   * };
   *
   * const server = new Server({ handler });
   * const listener = Deno.listen({ port: 4505 });
   *
   * console.log("server listening on http://localhost:4505");
   *
   * await server.serve(listener);
   * ```
   *
   * @param listener The listener to accept connections from.
   */
  async serve(listener) {
    if (this.#closed) {
      throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
    }
    this.#trackListener(listener);
    try {
      return await this.#accept(listener);
    } finally {
      this.#untrackListener(listener);
      try {
        listener.close();
      } catch {
      }
    }
  }
  /**
   * Create a listener on the server, accept incoming connections, and handle
   * requests on these connections with the given handler.
   *
   * If the server was constructed without a specified port, 80 is used.
   *
   * If the server was constructed with the hostname omitted from the options, the
   * non-routable meta-address `0.0.0.0` is used.
   *
   * Throws a server closed error if the server has been closed.
   *
   * ```ts
   * import { Server } from "https://deno.land/std@$STD_VERSION/http/server.ts";
   *
   * const port = 4505;
   * const handler = (request: Request) => {
   *   const body = `Your user-agent is:\n\n${request.headers.get(
   *    "user-agent",
   *   ) ?? "Unknown"}`;
   *
   *   return new Response(body, { status: 200 });
   * };
   *
   * const server = new Server({ port, handler });
   *
   * console.log("server listening on http://localhost:4505");
   *
   * await server.listenAndServe();
   * ```
   */
  async listenAndServe() {
    if (this.#closed) {
      throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
    }
    const listener = Deno.listen({
      port: this.#port ?? HTTP_PORT,
      hostname: this.#host ?? "0.0.0.0",
      transport: "tcp"
    });
    return await this.serve(listener);
  }
  /**
   * Create a listener on the server, accept incoming connections, upgrade them
   * to TLS, and handle requests on these connections with the given handler.
   *
   * If the server was constructed without a specified port, 443 is used.
   *
   * If the server was constructed with the hostname omitted from the options, the
   * non-routable meta-address `0.0.0.0` is used.
   *
   * Throws a server closed error if the server has been closed.
   *
   * ```ts
   * import { Server } from "https://deno.land/std@$STD_VERSION/http/server.ts";
   *
   * const port = 4505;
   * const handler = (request: Request) => {
   *   const body = `Your user-agent is:\n\n${request.headers.get(
   *    "user-agent",
   *   ) ?? "Unknown"}`;
   *
   *   return new Response(body, { status: 200 });
   * };
   *
   * const server = new Server({ port, handler });
   *
   * const certFile = "/path/to/certFile.crt";
   * const keyFile = "/path/to/keyFile.key";
   *
   * console.log("server listening on https://localhost:4505");
   *
   * await server.listenAndServeTls(certFile, keyFile);
   * ```
   *
   * @param certFile The path to the file containing the TLS certificate.
   * @param keyFile The path to the file containing the TLS private key.
   */
  async listenAndServeTls(certFile, keyFile) {
    if (this.#closed) {
      throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
    }
    const listener = Deno.listenTls({
      port: this.#port ?? HTTPS_PORT,
      hostname: this.#host ?? "0.0.0.0",
      certFile,
      keyFile,
      transport: "tcp"
    });
    return await this.serve(listener);
  }
  /**
   * Immediately close the server listeners and associated HTTP connections.
   *
   * Throws a server closed error if called after the server has been closed.
   */
  close() {
    if (this.#closed) {
      throw new Deno.errors.Http(ERROR_SERVER_CLOSED);
    }
    this.#closed = true;
    for (const listener of this.#listeners) {
      try {
        listener.close();
      } catch {
      }
    }
    this.#listeners.clear();
    this.#acceptBackoffDelayAbortController.abort();
    for (const httpConn of this.#httpConnections) {
      this.#closeHttpConn(httpConn);
    }
    this.#httpConnections.clear();
  }
  /** Get whether the server is closed. */
  get closed() {
    return this.#closed;
  }
  /** Get the list of network addresses the server is listening on. */
  get addrs() {
    return Array.from(this.#listeners).map((listener) => listener.addr);
  }
  /**
   * Responds to an HTTP request.
   *
   * @param requestEvent The HTTP request to respond to.
   * @param connInfo Information about the underlying connection.
   */
  async #respond(requestEvent, connInfo) {
    let response;
    try {
      response = await this.#handler(requestEvent.request, connInfo);
      if (response.bodyUsed && response.body !== null) {
        throw new TypeError("Response body already consumed.");
      }
    } catch (error) {
      response = await this.#onError(error);
    }
    try {
      await requestEvent.respondWith(response);
    } catch {
    }
  }
  /**
   * Serves all HTTP requests on a single connection.
   *
   * @param httpConn The HTTP connection to yield requests from.
   * @param connInfo Information about the underlying connection.
   */
  async #serveHttp(httpConn, connInfo) {
    while (!this.#closed) {
      let requestEvent;
      try {
        requestEvent = await httpConn.nextRequest();
      } catch {
        break;
      }
      if (requestEvent === null) {
        break;
      }
      this.#respond(requestEvent, connInfo);
    }
    this.#closeHttpConn(httpConn);
  }
  /**
   * Accepts all connections on a single network listener.
   *
   * @param listener The listener to accept connections from.
   */
  async #accept(listener) {
    let acceptBackoffDelay;
    while (!this.#closed) {
      let conn;
      try {
        conn = await listener.accept();
      } catch (error) {
        if (error instanceof Deno.errors.BadResource || // TLS handshake errors.
        error instanceof Deno.errors.InvalidData || error instanceof Deno.errors.UnexpectedEof || error instanceof Deno.errors.ConnectionReset || error instanceof Deno.errors.NotConnected) {
          if (!acceptBackoffDelay) {
            acceptBackoffDelay = INITIAL_ACCEPT_BACKOFF_DELAY;
          } else {
            acceptBackoffDelay *= 2;
          }
          if (acceptBackoffDelay >= MAX_ACCEPT_BACKOFF_DELAY) {
            acceptBackoffDelay = MAX_ACCEPT_BACKOFF_DELAY;
          }
          try {
            await delay(acceptBackoffDelay, {
              signal: this.#acceptBackoffDelayAbortController.signal
            });
          } catch (err) {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              throw err;
            }
          }
          continue;
        }
        throw error;
      }
      acceptBackoffDelay = void 0;
      let httpConn;
      try {
        httpConn = Deno.serveHttp(conn);
      } catch {
        continue;
      }
      this.#trackHttpConnection(httpConn);
      const connInfo = {
        localAddr: conn.localAddr,
        remoteAddr: conn.remoteAddr
      };
      this.#serveHttp(httpConn, connInfo);
    }
  }
  /**
   * Untracks and closes an HTTP connection.
   *
   * @param httpConn The HTTP connection to close.
   */
  #closeHttpConn(httpConn) {
    this.#untrackHttpConnection(httpConn);
    try {
      httpConn.close();
    } catch {
    }
  }
  /**
   * Adds the listener to the internal tracking list.
   *
   * @param listener Listener to track.
   */
  #trackListener(listener) {
    this.#listeners.add(listener);
  }
  /**
   * Removes the listener from the internal tracking list.
   *
   * @param listener Listener to untrack.
   */
  #untrackListener(listener) {
    this.#listeners.delete(listener);
  }
  /**
   * Adds the HTTP connection to the internal tracking list.
   *
   * @param httpConn HTTP connection to track.
   */
  #trackHttpConnection(httpConn) {
    this.#httpConnections.add(httpConn);
  }
  /**
   * Removes the HTTP connection from the internal tracking list.
   *
   * @param httpConn HTTP connection to untrack.
   */
  #untrackHttpConnection(httpConn) {
    this.#httpConnections.delete(httpConn);
  }
};
function hostnameForDisplay(hostname) {
  return hostname === "0.0.0.0" ? "localhost" : hostname;
}
async function serve(handler2, options = {}) {
  let port = options.port ?? 8e3;
  if (typeof port !== "number") {
    port = Number(port);
  }
  const hostname = options.hostname ?? "0.0.0.0";
  const server = new Server({
    port,
    hostname,
    handler: handler2,
    onError: options.onError
  });
  options?.signal?.addEventListener("abort", () => server.close(), {
    once: true
  });
  const listener = Deno.listen({
    port,
    hostname,
    transport: "tcp"
  });
  const s = server.serve(listener);
  port = server.addrs[0].port;
  if ("onListen" in options) {
    options.onListen?.({
      port,
      hostname
    });
  } else {
    console.log(`Listening on http://${hostnameForDisplay(hostname)}:${port}/`);
  }
  return await s;
}

// src/constants.ts
var CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
var CEREBRAS_PUBLIC_MODELS_URL = "https://api.cerebras.ai/public/v1/models";
var KV_PREFIX = "cerebras-proxy";
var CONFIG_KEY = [
  KV_PREFIX,
  "meta",
  "config"
];
var MODEL_CATALOG_KEY = [
  KV_PREFIX,
  "meta",
  "model_catalog"
];
var API_KEY_PREFIX = [
  KV_PREFIX,
  "keys",
  "api"
];
var PROXY_KEY_PREFIX = [
  KV_PREFIX,
  "keys",
  "proxy"
];
var ADMIN_PASSWORD_KEY = [
  KV_PREFIX,
  "meta",
  "admin_password"
];
var ADMIN_TOKEN_PREFIX = [
  KV_PREFIX,
  "auth",
  "token"
];
var KV_ATOMIC_MAX_RETRIES = 10;
var MAX_PROXY_KEYS = 5;
var MAX_MODEL_NOT_FOUND_RETRIES = 3;
var ADMIN_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1e3;
var UPSTREAM_TEST_TIMEOUT_MS = 12e3;
var PROXY_REQUEST_TIMEOUT_MS = 6e4;
var DEFAULT_KV_FLUSH_INTERVAL_MS = 15e3;
var MIN_KV_FLUSH_INTERVAL_MS = 1e3;
var MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1e3;
var MODEL_CATALOG_FETCH_TIMEOUT_MS = 8e3;
var DEFAULT_MODEL_POOL = [
  "gpt-oss-120b",
  "qwen-3-235b-a22b-instruct-2507",
  "zai-glm-4.7"
];
var FALLBACK_MODEL = "qwen-3-235b-a22b-instruct-2507";
var EXTERNAL_MODEL_ID = "cerebras-translator";
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token"
};
var NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0"
};

// src/http.ts
function jsonResponse(data, options = {}) {
  const headers = new Headers({
    ...CORS_HEADERS,
    ...NO_CACHE_HEADERS,
    "Content-Type": "application/json"
  });
  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers
  });
}
function jsonError(message, status = 400, headers) {
  return jsonResponse({
    error: message
  }, {
    status,
    headers
  });
}
function problemTitle(status) {
  if (status >= 500) return "\u670D\u52A1\u5668\u9519\u8BEF";
  switch (status) {
    case 400:
      return "\u8BF7\u6C42\u9519\u8BEF";
    case 401:
      return "\u672A\u6388\u6743";
    case 403:
      return "\u7981\u6B62\u8BBF\u95EE";
    case 404:
      return "\u672A\u627E\u5230";
    case 409:
      return "\u51B2\u7A81";
    case 429:
      return "\u8BF7\u6C42\u8FC7\u591A";
    default:
      return "\u8BF7\u6C42\u5931\u8D25";
  }
}
function problemResponse(detail, options = {}) {
  const status = options.status ?? 400;
  const headers = new Headers({
    "Content-Type": "application/problem+json"
  });
  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return jsonResponse({
    type: options.type ?? "about:blank",
    title: options.title ?? problemTitle(status),
    status,
    detail,
    ...options.instance ? {
      instance: options.instance
    } : {}
  }, {
    status,
    headers
  });
}

// src/state.ts
var isDenoDeployment = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
var kv = await (() => {
  if (isDenoDeployment) return Deno.openKv();
  const kvDir = `${import.meta.dirname}/.deno-kv-local`;
  try {
    Deno.mkdirSync(kvDir, {
      recursive: true
    });
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists || typeof e === "object" && e !== null && "name" in e && e.name === "AlreadyExists") {
    } else {
      console.error("[KV] \u65E0\u6CD5\u521B\u5EFA\u672C\u5730 KV \u76EE\u5F55\uFF1A", e);
      throw e;
    }
  }
  return Deno.openKv(`${kvDir}/kv.sqlite3`);
})();
var cachedConfig = null;
function setCachedConfig(config) {
  cachedConfig = config;
}
var cachedKeysById = /* @__PURE__ */ new Map();
function setCachedKeysById(keys) {
  cachedKeysById = keys;
}
var cachedActiveKeyIds = [];
function setCachedActiveKeyIds(ids) {
  cachedActiveKeyIds = ids;
}
var cachedCursor = 0;
function setCachedCursor(cursor) {
  cachedCursor = cursor;
}
var keyCooldownUntil = /* @__PURE__ */ new Map();
var dirtyKeyIds = /* @__PURE__ */ new Set();
var dirtyConfig = false;
function setDirtyConfig(dirty) {
  dirtyConfig = dirty;
}
var flushInProgress = false;
function setFlushInProgress(inProgress) {
  flushInProgress = inProgress;
}
var cachedModelPool = [];
function setCachedModelPool(pool) {
  cachedModelPool = pool;
}
var modelCursor = 0;
function setModelCursor(cursor) {
  modelCursor = cursor;
}
var cachedModelCatalog = null;
function setCachedModelCatalog(catalog) {
  cachedModelCatalog = catalog;
}
var modelCatalogFetchInFlight = null;
function setModelCatalogFetchInFlight(promise) {
  modelCatalogFetchInFlight = promise;
}
var cachedProxyKeys = /* @__PURE__ */ new Map();
function setCachedProxyKeys(keys) {
  cachedProxyKeys = keys;
}
var dirtyProxyKeyIds = /* @__PURE__ */ new Set();
var kvFlushTimerId = null;
function setKvFlushTimerId(id) {
  kvFlushTimerId = id;
}
var kvFlushIntervalMsEffective = DEFAULT_KV_FLUSH_INTERVAL_MS;
function setKvFlushIntervalMsEffective(ms) {
  kvFlushIntervalMsEffective = ms;
}

// src/crypto.ts
var PBKDF2_ITERATIONS = 1e5;
var PBKDF2_KEY_LENGTH = 32;
async function hashPassword(password, salt) {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);
  const derivedBits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: actualSalt.buffer,
    iterations: PBKDF2_ITERATIONS,
    hash: "SHA-256"
  }, passwordKey, PBKDF2_KEY_LENGTH * 8);
  const derivedKey = new Uint8Array(derivedBits);
  const saltB64 = btoa(String.fromCharCode(...actualSalt));
  const keyB64 = btoa(String.fromCharCode(...derivedKey));
  return `v1$pbkdf2$${PBKDF2_ITERATIONS}$${saltB64}$${keyB64}`;
}
async function verifyPbkdf2Password(password, stored) {
  const parts = stored.split("$");
  if (!(parts.length === 5 && parts[0] === "v1" && parts[1] === "pbkdf2")) {
    return false;
  }
  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt;
  let storedKey;
  try {
    salt = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
    storedKey = Uint8Array.from(atob(parts[4]), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);
  const derivedBits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: salt.buffer,
    iterations,
    hash: "SHA-256"
  }, passwordKey, storedKey.length * 8);
  const computedKey = new Uint8Array(derivedBits);
  if (computedKey.length !== storedKey.length) return false;
  let diff = 0;
  for (let i = 0; i < computedKey.length; i++) {
    diff |= computedKey[i] ^ storedKey[i];
  }
  return diff === 0;
}

// src/auth.ts
async function getAdminPassword() {
  const entry = await kv.get(ADMIN_PASSWORD_KEY);
  return entry.value;
}
async function setAdminPassword(password) {
  const hash = await hashPassword(password);
  await kv.set(ADMIN_PASSWORD_KEY, hash);
}
async function verifyAdminPassword(password) {
  const stored = await getAdminPassword();
  if (!stored) return false;
  return await verifyPbkdf2Password(password, stored);
}
async function createAdminToken() {
  const token = crypto.randomUUID();
  const expiry = Date.now() + ADMIN_TOKEN_EXPIRY_MS;
  await kv.set([
    ...ADMIN_TOKEN_PREFIX,
    token
  ], expiry);
  return token;
}
async function verifyAdminToken(token) {
  if (!token) return false;
  const entry = await kv.get([
    ...ADMIN_TOKEN_PREFIX,
    token
  ]);
  if (!entry.value) return false;
  if (Date.now() > entry.value) {
    await kv.delete([
      ...ADMIN_TOKEN_PREFIX,
      token
    ]);
    return false;
  }
  return true;
}
async function deleteAdminToken(token) {
  await kv.delete([
    ...ADMIN_TOKEN_PREFIX,
    token
  ]);
}
async function isAdminAuthorized(req) {
  const token = req.headers.get("X-Admin-Token");
  return await verifyAdminToken(token);
}
function isProxyAuthorized(req) {
  if (cachedProxyKeys.size === 0) {
    return {
      authorized: true
    };
  }
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      authorized: false
    };
  }
  const token = authHeader.substring(7).trim();
  for (const [id, pk] of cachedProxyKeys) {
    if (pk.key === token) {
      return {
        authorized: true,
        keyId: id
      };
    }
  }
  return {
    authorized: false
  };
}
function recordProxyKeyUsage(keyId) {
  const pk = cachedProxyKeys.get(keyId);
  if (!pk) return;
  pk.useCount++;
  pk.lastUsed = Date.now();
  dirtyProxyKeyIds.add(keyId);
}

// src/keys.ts
function generateProxyKey() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const base64 = btoa(String.fromCharCode(...randomBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return "cpk_" + base64;
}

// src/utils.ts
function generateId() {
  return crypto.randomUUID();
}
function maskKey(key) {
  if (key.length <= 8) return "*".repeat(key.length);
  return key.substring(0, 4) + "*".repeat(key.length - 8) + key.substring(key.length - 4);
}
function parseBatchInput(input) {
  return input.split(/[\n,\s]+/).map((k) => k.trim()).filter((k) => k.length > 0);
}
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isAbortError(error) {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return error.name === "AbortError";
  }
  return false;
}
async function fetchWithTimeout(input, init, timeoutMs) {
  const controller = new AbortController();
  const externalSignal = init.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), {
        once: true
      });
    }
  }
  const timeoutId = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function normalizeKvFlushIntervalMs(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_KV_FLUSH_INTERVAL_MS;
  return Math.max(MIN_KV_FLUSH_INTERVAL_MS, Math.trunc(ms));
}

// src/api-keys.ts
function rebuildActiveKeyIds() {
  const keys = Array.from(cachedKeysById.values());
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  setCachedActiveKeyIds(keys.filter((k) => k.status === "active").map((k) => k.id));
  if (cachedActiveKeyIds.length === 0) {
    setCachedCursor(0);
    return;
  }
  setCachedCursor(cachedCursor % cachedActiveKeyIds.length);
}
function getNextApiKeyFast(now) {
  if (cachedActiveKeyIds.length === 0) return null;
  for (let offset = 0; offset < cachedActiveKeyIds.length; offset++) {
    const idx = (cachedCursor + offset) % cachedActiveKeyIds.length;
    const id = cachedActiveKeyIds[idx];
    const cooldownUntil = keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;
    const keyEntry = cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== "active") continue;
    setCachedCursor((idx + 1) % cachedActiveKeyIds.length);
    keyEntry.useCount += 1;
    keyEntry.lastUsed = now;
    dirtyKeyIds.add(id);
    if (cachedConfig) {
      cachedConfig.totalRequests += 1;
      setDirtyConfig(true);
    }
    return {
      key: keyEntry.key,
      id
    };
  }
  return null;
}
function markKeyCooldownFrom429(id, response) {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number.parseInt(retryAfter, 10) * 1e3 : 2e3;
  keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}
function markKeyInvalid(id) {
  const keyEntry = cachedKeysById.get(id);
  if (!keyEntry) return;
  if (keyEntry.status === "invalid") return;
  keyEntry.status = "invalid";
  dirtyKeyIds.add(id);
  keyCooldownUntil.delete(id);
  rebuildActiveKeyIds();
}

// src/models.ts
function normalizeModelPool(rawPool) {
  const base = Array.isArray(rawPool) ? rawPool : [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const m of base) {
    const name = typeof m === "string" ? m.trim() : "";
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
function isModelNotFoundText(text) {
  const lower = text.toLowerCase();
  return lower.includes("model_not_found") || lower.includes("model not found") || lower.includes("no such model");
}
function isModelNotFoundPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!("error" in payload)) return false;
  const errorValue = payload.error;
  if (typeof errorValue === "string") {
    return isModelNotFoundText(errorValue);
  }
  if (!errorValue || typeof errorValue !== "object") return false;
  const code = errorValue.code;
  if (code === "model_not_found") return true;
  const type = errorValue.type;
  if (type === "model_not_found") return true;
  const message = errorValue.message;
  if (typeof message === "string") {
    return isModelNotFoundText(message);
  }
  return false;
}
function getNextModelFast() {
  if (cachedModelPool.length === 0) {
    return null;
  }
  const idx = modelCursor % cachedModelPool.length;
  const model = cachedModelPool[idx];
  setModelCursor((idx + 1) % cachedModelPool.length);
  if (cachedConfig) {
    cachedConfig.currentModelIndex = modelCursor;
    setDirtyConfig(true);
  }
  return model;
}
function rebuildModelPoolCache() {
  setCachedModelPool(normalizeModelPool(cachedConfig?.modelPool));
  if (cachedModelPool.length > 0) {
    const idx = cachedConfig?.currentModelIndex ?? 0;
    setModelCursor(idx % cachedModelPool.length);
    return;
  }
  setModelCursor(0);
}

// src/kv.ts
function resolveKvFlushIntervalMs(config) {
  const ms = config?.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS;
  return normalizeKvFlushIntervalMs(ms);
}
function applyKvFlushInterval(config) {
  setKvFlushIntervalMsEffective(resolveKvFlushIntervalMs(config));
  if (kvFlushTimerId !== null) {
    clearInterval(kvFlushTimerId);
  }
  setKvFlushTimerId(setInterval(flushDirtyToKv, kvFlushIntervalMsEffective));
}
async function flushDirtyToKv() {
  const now = Date.now();
  for (const [id, until] of keyCooldownUntil) {
    if (until < now) {
      keyCooldownUntil.delete(id);
    }
  }
  if (flushInProgress) return;
  if (!dirtyConfig && dirtyKeyIds.size === 0 && dirtyProxyKeyIds.size === 0) {
    return;
  }
  if (!cachedConfig) return;
  setFlushInProgress(true);
  const keyIds = Array.from(dirtyKeyIds);
  dirtyKeyIds.clear();
  const proxyKeyIds = Array.from(dirtyProxyKeyIds);
  dirtyProxyKeyIds.clear();
  const flushConfig = dirtyConfig;
  setDirtyConfig(false);
  try {
    const tasks = [];
    for (const id of keyIds) {
      const keyEntry = cachedKeysById.get(id);
      if (!keyEntry) continue;
      tasks.push(kv.set([
        ...API_KEY_PREFIX,
        id
      ], keyEntry));
    }
    for (const id of proxyKeyIds) {
      const pk = cachedProxyKeys.get(id);
      if (!pk) continue;
      tasks.push(kv.set([
        ...PROXY_KEY_PREFIX,
        id
      ], pk));
    }
    if (flushConfig) {
      tasks.push(kv.set(CONFIG_KEY, cachedConfig));
    }
    await Promise.all(tasks);
  } catch (error) {
    for (const id of keyIds) dirtyKeyIds.add(id);
    for (const id of proxyKeyIds) dirtyProxyKeyIds.add(id);
    setDirtyConfig(dirtyConfig || flushConfig);
    console.error(`[KV] flush failed:`, error);
  } finally {
    setFlushInProgress(false);
  }
}
async function bootstrapCache() {
  setCachedConfig(await kvGetConfig());
  const keys = await kvGetAllKeys();
  setCachedKeysById(new Map(keys.map((k) => [
    k.id,
    k
  ])));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();
  const proxyKeys = await kvGetAllProxyKeys();
  setCachedProxyKeys(new Map(proxyKeys.map((k) => [
    k.id,
    k
  ])));
}
async function kvEnsureConfigEntry() {
  let entry = await kv.get(CONFIG_KEY);
  if (!entry.value) {
    const defaultConfig = {
      modelPool: [
        ...DEFAULT_MODEL_POOL
      ],
      currentModelIndex: 0,
      totalRequests: 0,
      kvFlushIntervalMs: DEFAULT_KV_FLUSH_INTERVAL_MS,
      schemaVersion: "5.0"
    };
    await kv.set(CONFIG_KEY, defaultConfig);
    entry = await kv.get(CONFIG_KEY);
  }
  if (!entry.value) {
    throw new Error("KV \u914D\u7F6E\u521D\u59CB\u5316\u5931\u8D25");
  }
  const raw = entry.value;
  const modelPool = Array.isArray(raw.modelPool) ? normalizeModelPool(raw.modelPool) : [
    ...DEFAULT_MODEL_POOL
  ];
  const currentModelIndex = typeof raw.currentModelIndex === "number" && Number.isFinite(raw.currentModelIndex) && raw.currentModelIndex >= 0 ? Math.trunc(raw.currentModelIndex) : 0;
  const totalRequests = typeof raw.totalRequests === "number" && Number.isFinite(raw.totalRequests) && raw.totalRequests >= 0 ? Math.trunc(raw.totalRequests) : 0;
  const kvFlushIntervalMs = typeof raw.kvFlushIntervalMs === "number" && Number.isFinite(raw.kvFlushIntervalMs) ? raw.kvFlushIntervalMs : DEFAULT_KV_FLUSH_INTERVAL_MS;
  const needsMigration = raw.schemaVersion !== "5.0" || "disabledModels" in raw;
  if (needsMigration) {
    const nextConfig = {
      modelPool,
      currentModelIndex,
      totalRequests,
      kvFlushIntervalMs,
      schemaVersion: "5.0"
    };
    await kv.set(CONFIG_KEY, nextConfig);
    entry = await kv.get(CONFIG_KEY);
  }
  if (!entry.value) {
    throw new Error("KV \u914D\u7F6E\u521D\u59CB\u5316\u5931\u8D25");
  }
  return entry;
}
async function kvGetConfig() {
  const entry = await kvEnsureConfigEntry();
  return entry.value;
}
async function kvUpdateConfig(updater) {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await kvEnsureConfigEntry();
    const nextConfig = await updater(entry.value);
    if (nextConfig === entry.value) {
      setCachedConfig(entry.value);
      return entry.value;
    }
    const result = await kv.atomic().check(entry).set(CONFIG_KEY, nextConfig).commit();
    if (result.ok) {
      setCachedConfig(nextConfig);
      return nextConfig;
    }
  }
  throw new Error("\u914D\u7F6E\u66F4\u65B0\u5931\u8D25\uFF1A\u8FBE\u5230\u6700\u5927\u91CD\u8BD5\u6B21\u6570");
}
function isModelCatalogFresh(catalog, now) {
  return now >= catalog.fetchedAt && now - catalog.fetchedAt < MODEL_CATALOG_TTL_MS;
}
async function kvGetModelCatalog() {
  const entry = await kv.get(MODEL_CATALOG_KEY);
  return entry.value ?? null;
}
async function refreshModelCatalog() {
  if (modelCatalogFetchInFlight) {
    return await modelCatalogFetchInFlight;
  }
  const promise = (async () => {
    const response = await fetchWithTimeout(CEREBRAS_PUBLIC_MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }, MODEL_CATALOG_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const suffix = text && text.length <= 200 ? `: ${text}` : "";
      throw new Error(`\u6A21\u578B\u76EE\u5F55\u62C9\u53D6\u5931\u8D25\uFF1AHTTP ${response.status}${suffix}`);
    }
    const data = await response.json().catch(() => ({}));
    const rawModels = data?.data;
    const ids = Array.isArray(rawModels) ? rawModels.map((m) => {
      if (!m || typeof m !== "object") return "";
      if (!("id" in m)) return "";
      const id = m.id;
      return typeof id === "string" ? id.trim() : "";
    }).filter((id) => id.length > 0) : [];
    const seen = /* @__PURE__ */ new Set();
    const models = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
    const catalog = {
      source: "cerebras-public",
      fetchedAt: Date.now(),
      models
    };
    setCachedModelCatalog(catalog);
    try {
      await kv.set(MODEL_CATALOG_KEY, catalog);
    } catch (error) {
      console.error(`[KV] model catalog save failed:`, error);
    }
    return catalog;
  })().finally(() => {
    setModelCatalogFetchInFlight(null);
  });
  setModelCatalogFetchInFlight(promise);
  return await promise;
}
async function removeModelFromPool(model, reason) {
  const trimmed = model.trim();
  if (!trimmed) return;
  const existed = cachedModelPool.includes(trimmed);
  await kvUpdateConfig((config) => {
    const pool = normalizeModelPool(config.modelPool);
    const nextPool = pool.filter((m) => m !== trimmed);
    if (nextPool.length === pool.length) {
      return config;
    }
    return {
      ...config,
      modelPool: nextPool,
      currentModelIndex: 0,
      schemaVersion: "5.0"
    };
  });
  rebuildModelPoolCache();
  if (existed) {
    console.warn(`[MODEL] removed (${reason}): ${trimmed}`);
  }
}
async function kvGetAllKeys() {
  const keys = [];
  const iter = kv.list({
    prefix: API_KEY_PREFIX
  });
  for await (const entry of iter) {
    keys.push(entry.value);
  }
  return keys;
}
async function kvAddKey(key) {
  const allKeys = Array.from(cachedKeysById.values());
  const existingKey = allKeys.find((k) => k.key === key);
  if (existingKey) {
    return {
      success: false,
      error: "\u5BC6\u94A5\u5DF2\u5B58\u5728"
    };
  }
  const id = generateId();
  const newKey = {
    id,
    key,
    useCount: 0,
    status: "active",
    createdAt: Date.now()
  };
  await kv.set([
    ...API_KEY_PREFIX,
    id
  ], newKey);
  cachedKeysById.set(id, newKey);
  rebuildActiveKeyIds();
  return {
    success: true,
    id
  };
}
async function kvDeleteKey(id) {
  const key = [
    ...API_KEY_PREFIX,
    id
  ];
  const result = await kv.get(key);
  if (!result.value) {
    return {
      success: false,
      error: "\u5BC6\u94A5\u4E0D\u5B58\u5728"
    };
  }
  await kv.delete(key);
  cachedKeysById.delete(id);
  keyCooldownUntil.delete(id);
  dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
  return {
    success: true
  };
}
async function kvUpdateKey(id, updates) {
  const key = [
    ...API_KEY_PREFIX,
    id
  ];
  const existing = cachedKeysById.get(id) ?? (await kv.get(key)).value;
  if (!existing) return;
  const updated = {
    ...existing,
    ...updates
  };
  await kv.set(key, updated);
  cachedKeysById.set(id, updated);
  rebuildActiveKeyIds();
}
async function kvGetAllProxyKeys() {
  const keys = [];
  const iter = kv.list({
    prefix: PROXY_KEY_PREFIX
  });
  for await (const entry of iter) {
    keys.push(entry.value);
  }
  return keys;
}
async function kvAddProxyKey(name) {
  if (cachedProxyKeys.size >= MAX_PROXY_KEYS) {
    return {
      success: false,
      error: `\u6700\u591A\u53EA\u80FD\u521B\u5EFA ${MAX_PROXY_KEYS} \u4E2A\u4EE3\u7406\u5BC6\u94A5`
    };
  }
  const id = generateId();
  const key = generateProxyKey();
  const newKey = {
    id,
    key,
    name: name || `\u5BC6\u94A5 ${cachedProxyKeys.size + 1}`,
    useCount: 0,
    createdAt: Date.now()
  };
  await kv.set([
    ...PROXY_KEY_PREFIX,
    id
  ], newKey);
  cachedProxyKeys.set(id, newKey);
  return {
    success: true,
    id,
    key
  };
}
async function kvDeleteProxyKey(id) {
  const key = [
    ...PROXY_KEY_PREFIX,
    id
  ];
  const result = await kv.get(key);
  if (!result.value) {
    return {
      success: false,
      error: "\u5BC6\u94A5\u4E0D\u5B58\u5728"
    };
  }
  await kv.delete(key);
  cachedProxyKeys.delete(id);
  dirtyProxyKeyIds.delete(id);
  return {
    success: true
  };
}

// src/handlers/auth.ts
async function handleAuthRoutes(req, path) {
  if (!path.startsWith("/api/auth/")) return null;
  if (req.method === "GET" && path === "/api/auth/status") {
    const hasPassword = await getAdminPassword() !== null;
    const token = req.headers.get("X-Admin-Token");
    const isLoggedIn = await verifyAdminToken(token);
    return jsonResponse({
      hasPassword,
      isLoggedIn
    });
  }
  if (req.method === "POST" && path === "/api/auth/setup") {
    const hasPassword = await getAdminPassword() !== null;
    if (hasPassword) {
      return problemResponse("\u5BC6\u7801\u5DF2\u8BBE\u7F6E", {
        status: 400,
        instance: path
      });
    }
    try {
      const { password } = await req.json();
      if (!password || password.length < 4) {
        return problemResponse("\u5BC6\u7801\u81F3\u5C11 4 \u4F4D", {
          status: 400,
          instance: path
        });
      }
      await setAdminPassword(password);
      const token = await createAdminToken();
      return jsonResponse({
        success: true,
        token
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "POST" && path === "/api/auth/login") {
    try {
      const { password } = await req.json();
      const valid = await verifyAdminPassword(password);
      if (!valid) {
        return problemResponse("\u5BC6\u7801\u9519\u8BEF", {
          status: 401,
          instance: path
        });
      }
      const token = await createAdminToken();
      return jsonResponse({
        success: true,
        token
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "POST" && path === "/api/auth/logout") {
    const token = req.headers.get("X-Admin-Token");
    if (token) {
      await deleteAdminToken(token);
    }
    return jsonResponse({
      success: true
    });
  }
  return problemResponse("Not Found", {
    status: 404,
    instance: path
  });
}

// src/handlers/proxy-keys.ts
async function handleProxyKeyRoutes(req, path) {
  if (req.method === "GET" && path === "/api/proxy-keys") {
    const keys = Array.from(cachedProxyKeys.values());
    const masked = keys.map((k) => ({
      id: k.id,
      key: maskKey(k.key),
      name: k.name,
      useCount: k.useCount,
      lastUsed: k.lastUsed,
      createdAt: k.createdAt
    }));
    return jsonResponse({
      keys: masked,
      maxKeys: MAX_PROXY_KEYS,
      authEnabled: cachedProxyKeys.size > 0
    });
  }
  if (req.method === "POST" && path === "/api/proxy-keys") {
    try {
      const { name } = await req.json().catch(() => ({
        name: ""
      }));
      const result = await kvAddProxyKey(name);
      if (!result.success) {
        return problemResponse(result.error ?? "\u521B\u5EFA\u5931\u8D25", {
          status: 400,
          instance: path
        });
      }
      return jsonResponse(result, {
        status: 201
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "DELETE" && path.startsWith("/api/proxy-keys/")) {
    const id = path.split("/").pop();
    const result = await kvDeleteProxyKey(id);
    if (!result.success) {
      return problemResponse(result.error ?? "\u5220\u9664\u5931\u8D25", {
        status: result.error === "\u5BC6\u94A5\u4E0D\u5B58\u5728" ? 404 : 400,
        instance: path
      });
    }
    return jsonResponse(result);
  }
  if (req.method === "GET" && path.startsWith("/api/proxy-keys/") && path.endsWith("/export")) {
    const id = path.split("/")[3];
    const pk = cachedProxyKeys.get(id);
    if (!pk) {
      return problemResponse("\u5BC6\u94A5\u4E0D\u5B58\u5728", {
        status: 404,
        instance: path
      });
    }
    return jsonResponse({
      key: pk.key
    });
  }
  return null;
}

// src/handlers/api-keys.ts
async function testKey(id) {
  const apiKey = cachedKeysById.get(id);
  if (!apiKey) {
    return {
      success: false,
      status: "invalid",
      error: "\u5BC6\u94A5\u4E0D\u5B58\u5728"
    };
  }
  const testModel = cachedModelPool.length > 0 ? cachedModelPool[0] : FALLBACK_MODEL;
  try {
    const response = await fetchWithTimeout(CEREBRAS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.key}`
      },
      body: JSON.stringify({
        model: testModel,
        messages: [
          {
            role: "user",
            content: "test"
          }
        ],
        max_tokens: 1
      })
    }, UPSTREAM_TEST_TIMEOUT_MS);
    if (response.ok) {
      await kvUpdateKey(id, {
        status: "active"
      });
      return {
        success: true,
        status: "active"
      };
    }
    if (response.status === 401 || response.status === 403) {
      await kvUpdateKey(id, {
        status: "invalid"
      });
      return {
        success: false,
        status: "invalid",
        error: `HTTP ${response.status}`
      };
    }
    if (response.status === 404) {
      const clone = response.clone();
      const bodyText = await clone.text().catch(() => "");
      const payload = safeJsonParse(bodyText);
      const modelNotFound = isModelNotFoundPayload(payload) || isModelNotFoundText(bodyText);
      if (modelNotFound) {
        await removeModelFromPool(testModel, "model_not_found");
        await kvUpdateKey(id, {
          status: "active"
        });
        return {
          success: true,
          status: "active"
        };
      }
    }
    await kvUpdateKey(id, {
      status: "inactive"
    });
    return {
      success: false,
      status: "inactive",
      error: `HTTP ${response.status}`
    };
  } catch (error) {
    const msg = isAbortError(error) ? "\u8BF7\u6C42\u8D85\u65F6" : getErrorMessage(error);
    await kvUpdateKey(id, {
      status: "inactive"
    });
    return {
      success: false,
      status: "inactive",
      error: msg
    };
  }
}
async function handleApiKeyRoutes(req, path) {
  if (req.method === "GET" && path === "/api/keys") {
    const keys = await kvGetAllKeys();
    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskKey(k.key)
    }));
    return jsonResponse({
      keys: maskedKeys
    });
  }
  if (req.method === "POST" && path === "/api/keys") {
    try {
      const { key } = await req.json();
      if (!key) {
        return problemResponse("\u5BC6\u94A5\u4E0D\u80FD\u4E3A\u7A7A", {
          status: 400,
          instance: path
        });
      }
      const result = await kvAddKey(key);
      if (!result.success) {
        return problemResponse(result.error ?? "\u6DFB\u52A0\u5931\u8D25", {
          status: result.error === "\u5BC6\u94A5\u5DF2\u5B58\u5728" ? 409 : 400,
          instance: path
        });
      }
      return jsonResponse(result, {
        status: 201
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "POST" && path === "/api/keys/batch") {
    try {
      const contentType = req.headers.get("Content-Type") || "";
      let input;
      if (contentType.includes("application/json")) {
        const body = await req.json();
        input = body.input || (typeof body === "string" ? body : "");
      } else {
        input = await req.text();
      }
      if (!input?.trim()) {
        return problemResponse("\u8F93\u5165\u4E0D\u80FD\u4E3A\u7A7A", {
          status: 400,
          instance: path
        });
      }
      const keys = parseBatchInput(input);
      const results = {
        success: [],
        failed: []
      };
      for (const key of keys) {
        const result = await kvAddKey(key);
        if (result.success) {
          results.success.push(maskKey(key));
        } else {
          results.failed.push({
            key: maskKey(key),
            error: result.error || "\u672A\u77E5\u9519\u8BEF"
          });
        }
      }
      return jsonResponse({
        summary: {
          total: keys.length,
          success: results.success.length,
          failed: results.failed.length
        },
        results
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "GET" && path === "/api/keys/export") {
    const keys = Array.from(cachedKeysById.values());
    const rawKeys = keys.map((k) => k.key);
    return jsonResponse({
      keys: rawKeys
    });
  }
  if (req.method === "GET" && path.startsWith("/api/keys/") && path.endsWith("/export")) {
    const id = path.split("/")[3];
    const keyEntry = cachedKeysById.get(id);
    if (!keyEntry) {
      return problemResponse("\u5BC6\u94A5\u4E0D\u5B58\u5728", {
        status: 404,
        instance: path
      });
    }
    return jsonResponse({
      key: keyEntry.key
    });
  }
  if (req.method === "DELETE" && path.startsWith("/api/keys/")) {
    const id = path.split("/").pop();
    const result = await kvDeleteKey(id);
    if (!result.success) {
      return problemResponse(result.error ?? "\u5220\u9664\u5931\u8D25", {
        status: result.error === "\u5BC6\u94A5\u4E0D\u5B58\u5728" ? 404 : 400,
        instance: path
      });
    }
    return jsonResponse(result);
  }
  if (req.method === "POST" && path.startsWith("/api/keys/") && path.endsWith("/test")) {
    const id = path.split("/")[3];
    const result = await testKey(id);
    return jsonResponse(result);
  }
  return null;
}

// src/handlers/models.ts
async function handleModelRoutes(req, path) {
  if (req.method === "GET" && path === "/api/models/catalog") {
    const now = Date.now();
    let catalog = cachedModelCatalog;
    if (!catalog || !isModelCatalogFresh(catalog, now)) {
      const kvCatalog = await kvGetModelCatalog();
      if (kvCatalog) {
        catalog = kvCatalog;
      }
    }
    let stale = true;
    let lastError;
    if (catalog && isModelCatalogFresh(catalog, now)) {
      stale = false;
    } else {
      try {
        catalog = await refreshModelCatalog();
        stale = false;
      } catch (error) {
        lastError = getErrorMessage(error);
        stale = true;
      }
    }
    if (!catalog) {
      return problemResponse(lastError ?? "\u65E0\u6CD5\u83B7\u53D6\u6A21\u578B\u76EE\u5F55", {
        status: 502,
        instance: path
      });
    }
    return jsonResponse({
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      ttlMs: MODEL_CATALOG_TTL_MS,
      stale,
      ...lastError ? {
        lastError
      } : {},
      models: catalog.models
    });
  }
  if (req.method === "POST" && path === "/api/models/catalog/refresh") {
    let catalog = cachedModelCatalog ?? await kvGetModelCatalog();
    try {
      catalog = await refreshModelCatalog();
      return jsonResponse({
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        ttlMs: MODEL_CATALOG_TTL_MS,
        stale: false,
        models: catalog.models
      });
    } catch (error) {
      const lastError = getErrorMessage(error);
      if (!catalog) {
        return problemResponse(lastError, {
          status: 502,
          instance: path
        });
      }
      return jsonResponse({
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        ttlMs: MODEL_CATALOG_TTL_MS,
        stale: true,
        lastError,
        models: catalog.models
      });
    }
  }
  if (req.method === "GET" && path === "/api/models") {
    const config = await kvGetConfig();
    const models = normalizeModelPool(config.modelPool);
    return jsonResponse({
      models
    });
  }
  if (req.method === "PUT" && path === "/api/models") {
    try {
      const body = await req.json().catch(() => ({}));
      const raw = body.models;
      if (!Array.isArray(raw)) {
        return problemResponse("models \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32\u6570\u7EC4", {
          status: 400,
          instance: path
        });
      }
      const seen = /* @__PURE__ */ new Set();
      const models = raw.map((m) => typeof m === "string" ? m.trim() : "").filter((m) => m.length > 0).filter((m) => {
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      });
      if (models.length === 0) {
        return problemResponse("\u6A21\u578B\u6C60\u4E0D\u80FD\u4E3A\u7A7A", {
          status: 400,
          instance: path
        });
      }
      await kvUpdateConfig((config) => ({
        ...config,
        modelPool: models,
        currentModelIndex: 0,
        schemaVersion: "5.0"
      }));
      rebuildModelPoolCache();
      return jsonResponse({
        success: true,
        models
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "POST" && path.startsWith("/api/models/") && path.endsWith("/test")) {
    const parts = path.split("/");
    const encodedName = parts[3];
    if (!encodedName) {
      return problemResponse("\u7F3A\u5C11\u6A21\u578B\u540D\u79F0", {
        status: 400,
        instance: path
      });
    }
    let modelName;
    try {
      modelName = decodeURIComponent(encodedName);
    } catch (_error) {
      return problemResponse("\u6A21\u578B\u540D\u79F0 URL \u7F16\u7801\u975E\u6CD5", {
        status: 400,
        instance: path
      });
    }
    const activeKey = Array.from(cachedKeysById.values()).find((k) => k.status === "active");
    if (!activeKey) {
      return problemResponse("\u6CA1\u6709\u53EF\u7528\u7684 API \u5BC6\u94A5", {
        status: 400,
        instance: path
      });
    }
    try {
      const response = await fetchWithTimeout(CEREBRAS_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeKey.key}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: "user",
              content: "test"
            }
          ],
          max_tokens: 1
        })
      }, UPSTREAM_TEST_TIMEOUT_MS);
      if (response.ok) {
        return jsonResponse({
          success: true,
          status: "available"
        });
      }
      if (response.status === 404) {
        const clone = response.clone();
        const bodyText = await clone.text().catch(() => "");
        const payload = safeJsonParse(bodyText);
        const modelNotFound = isModelNotFoundPayload(payload) || isModelNotFoundText(bodyText);
        if (modelNotFound) {
          await removeModelFromPool(modelName, "model_not_found");
          return jsonResponse({
            success: false,
            status: "model_not_found",
            error: "model_not_found"
          });
        }
      }
      if (response.status === 401 || response.status === 403) {
        await kvUpdateKey(activeKey.id, {
          status: "invalid"
        });
      }
      return jsonResponse({
        success: false,
        status: "unavailable",
        error: `HTTP ${response.status}`
      });
    } catch (error) {
      const msg = isAbortError(error) ? "\u8BF7\u6C42\u8D85\u65F6" : getErrorMessage(error);
      return jsonResponse({
        success: false,
        status: "error",
        error: msg
      });
    }
  }
  return null;
}

// src/handlers/config.ts
async function handleConfigRoutes(req, path) {
  if (req.method === "GET" && path === "/api/stats") {
    const [keys, config] = await Promise.all([
      kvGetAllKeys(),
      kvGetConfig()
    ]);
    const stats = {
      totalKeys: keys.length,
      activeKeys: keys.filter((k) => k.status === "active").length,
      totalRequests: config.totalRequests,
      keyUsage: keys.map((k) => ({
        id: k.id,
        maskedKey: maskKey(k.key),
        useCount: k.useCount,
        status: k.status
      }))
    };
    return jsonResponse(stats);
  }
  if (req.method === "PATCH" && path === "/api/config") {
    try {
      const body = await req.json().catch(() => ({}));
      const raw = body.kvFlushIntervalMs;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return problemResponse("kvFlushIntervalMs \u5FC5\u987B\u4E3A\u6570\u5B57", {
          status: 400,
          instance: path
        });
      }
      const normalized = normalizeKvFlushIntervalMs(raw);
      const next = await kvUpdateConfig((config) => ({
        ...config,
        kvFlushIntervalMs: normalized
      }));
      applyKvFlushInterval(next);
      return jsonResponse({
        success: true,
        kvFlushIntervalMs: normalized,
        effectiveKvFlushIntervalMs: kvFlushIntervalMsEffective,
        kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS
      });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path
      });
    }
  }
  if (req.method === "GET" && path === "/api/config") {
    const config = await kvGetConfig();
    const configured = normalizeKvFlushIntervalMs(config.kvFlushIntervalMs ?? MIN_KV_FLUSH_INTERVAL_MS);
    const effective = resolveKvFlushIntervalMs({
      ...config,
      kvFlushIntervalMs: configured
    });
    return jsonResponse({
      ...config,
      kvFlushIntervalMs: configured,
      effectiveKvFlushIntervalMs: effective,
      kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS
    });
  }
  return null;
}

// src/handlers/proxy.ts
function handleModelsEndpoint(_req) {
  const now = Math.floor(Date.now() / 1e3);
  return jsonResponse({
    object: "list",
    data: [
      {
        id: EXTERNAL_MODEL_ID,
        object: "model",
        created: now,
        owned_by: "cerebras"
      }
    ]
  });
}
async function handleProxyEndpoint(req) {
  const authResult = isProxyAuthorized(req);
  if (!authResult.authorized) {
    return jsonError("Unauthorized", 401);
  }
  if (authResult.keyId) {
    recordProxyKeyUsage(authResult.keyId);
  }
  try {
    const requestBody = await req.json();
    const apiKeyData = getNextApiKeyFast(Date.now());
    if (!apiKeyData) {
      const now = Date.now();
      const cooldowns = cachedActiveKeyIds.map((id) => keyCooldownUntil.get(id) ?? 0).filter((ms) => ms > now);
      const minCooldownUntil = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
      const retryAfterSeconds = minCooldownUntil > now ? Math.ceil((minCooldownUntil - now) / 1e3) : 0;
      return jsonError("\u6CA1\u6709\u53EF\u7528\u7684 API \u5BC6\u94A5", cachedActiveKeyIds.length > 0 ? 429 : 500, retryAfterSeconds > 0 ? {
        "Retry-After": String(retryAfterSeconds)
      } : void 0);
    }
    let lastModelNotFound = null;
    for (let attempt = 0; attempt < MAX_MODEL_NOT_FOUND_RETRIES; attempt++) {
      const targetModel = getNextModelFast();
      if (!targetModel) {
        return jsonError("\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B", 503);
      }
      requestBody.model = targetModel;
      let apiResponse;
      try {
        apiResponse = await fetchWithTimeout(CEREBRAS_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeyData.key}`
          },
          body: JSON.stringify(requestBody)
        }, PROXY_REQUEST_TIMEOUT_MS);
      } catch (error) {
        const timeout = isAbortError(error);
        const msg = timeout ? "\u4E0A\u6E38\u8BF7\u6C42\u8D85\u65F6" : getErrorMessage(error);
        return jsonError(msg, timeout ? 504 : 502);
      }
      if (apiResponse.status === 404) {
        const clone = apiResponse.clone();
        const bodyText = await clone.text().catch(() => "");
        const payload = safeJsonParse(bodyText);
        const modelNotFound = isModelNotFoundPayload(payload) || isModelNotFoundText(bodyText);
        if (modelNotFound) {
          lastModelNotFound = {
            status: apiResponse.status,
            statusText: apiResponse.statusText,
            headers: new Headers(apiResponse.headers),
            bodyText
          };
          apiResponse.body?.cancel();
          await removeModelFromPool(targetModel, "model_not_found");
          continue;
        }
      }
      if (apiResponse.status === 429) {
        markKeyCooldownFrom429(apiKeyData.id, apiResponse);
      }
      if (apiResponse.status === 401 || apiResponse.status === 403) {
        markKeyInvalid(apiKeyData.id);
      }
      const responseHeaders = new Headers(apiResponse.headers);
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      Object.entries(NO_CACHE_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      return new Response(apiResponse.body, {
        status: apiResponse.status,
        statusText: apiResponse.statusText,
        headers: responseHeaders
      });
    }
    if (lastModelNotFound) {
      const responseHeaders = new Headers(lastModelNotFound.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      responseHeaders.delete("transfer-encoding");
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      Object.entries(NO_CACHE_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      return new Response(lastModelNotFound.bodyText, {
        status: lastModelNotFound.status,
        statusText: lastModelNotFound.statusText,
        headers: responseHeaders
      });
    }
    return jsonError("\u6A21\u578B\u4E0D\u53EF\u7528", 502);
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

// src/ui/admin_page.ts
async function renderAdminPage() {
  const [keys, config] = await Promise.all([
    kvGetAllKeys(),
    kvGetConfig()
  ]);
  const proxyKeyCount = cachedProxyKeys.size;
  const stats = {
    totalKeys: keys.length,
    activeKeys: keys.filter((k) => k.status === "active").length,
    totalRequests: config.totalRequests,
    proxyAuthEnabled: proxyKeyCount > 0,
    proxyKeyCount
  };
  const faviconDataUri = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzA2YjZkNCIgZD0iTTIyIDRoLTkuNzdMMTEgLjM0YS41LjUgMCAwIDAtLjUtLjM0SDJhMiAyIDAgMCAwLTIgMnYxNmEyIDIgMCAwIDAgMiAyaDkuNjVMMTMgMjMuNjhhLjUuNSAwIDAgMCAuNDcuMzJIMjJhMiAyIDAgMCAwIDItMlY2YTIgMiAwIDAgMC0yLTJaTTcuNSAxNWE0LjUgNC41IDAgMSAxIDIuOTItNy45Mi41LjUgMCAxIDEtLjY1Ljc2QTMuNSAzLjUgMCAxIDAgMTEgMTFINy41YS41LjUgMCAwIDEgMC0xaDRhLjUuNSAwIDAgMSAuNS41QTQuNSA0LjUgMCAwIDEgNy41IDE1Wm0xMS45LTRhMTEuMjYgMTEuMjYgMCAwIDEtMS44NiAzLjI5IDYuNjcgNi42NyAwIDAgMS0xLjA3LTEuNDguNS41IDAgMCAwLS45My4zOCA4IDggMCAwIDAgMS4zNCAxLjg3IDguOSA4LjkgMCAwIDEtLjY1LjYyTDE0LjYyIDExWk0yMyAyMmExIDEgMCAwIDEtMSAxaC03LjRsMi43Ny0zLjE3YS40OS40OSAwIDAgMCAuMDktLjQ4bC0uOTEtMi42NmE5LjM2IDkuMzYgMCAwIDAgMS0uODljMSAxIDEuOTMgMS45MSAyLjEyIDIuMDhhLjUuNSAwIDAgMCAuNjgtLjc0IDQzLjQ4IDQzLjQ4IDAgMCAxLTIuMTMtMi4xIDExLjQ5IDExLjQ5IDAgMCAwIDIuMjItNGgxLjA2YS41LjUgMCAwIDAgMC0xSDE4VjkuNWEuNS41IDAgMCAwLTEgMHYuNWgtMi41YS40OS40OSAwIDAgMC0uMjEgMGwtMS43Mi01SDIyYTEgMSAwIDAgMSAxIDFaIi8+PC9zdmc+`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cerebras Translator</title>
  <link rel="icon" type="image/svg+xml" href="${faviconDataUri}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* ========== \u4EAE\u8272\u4E3B\u9898\uFF08\u9ED8\u8BA4\uFF09 ========== */
    body, body.light {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%);
      min-height: 100vh;
      padding: 40px 20px;
      color: #1e293b;
      transition: background 0.3s, color 0.3s;
    }
    body .container, body.light .container { max-width: 600px; margin: 0 auto; }
    body .header, body.light .header { text-align: center; margin-bottom: 24px; position: relative; }
    body .logo, body.light .logo { width: 48px; height: 48px; margin: 0 auto 12px; filter: drop-shadow(0 0 16px rgba(6, 182, 212, 0.5)); }
    body h1, body.light h1 { font-size: 22px; font-weight: 600; color: #1e293b; margin-bottom: 4px; }
    body h1 span, body.light h1 span { background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    body .subtitle, body.light .subtitle { font-size: 13px; color: #64748b; }
    body .card, body.light .card {
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(6, 182, 212, 0.15);
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
      overflow: hidden;
    }
    body .tabs, body.light .tabs { display: flex; border-bottom: 1px solid rgba(6, 182, 212, 0.15); background: rgba(248, 250, 252, 0.8); }
    body .tab, body.light .tab {
      flex: 1; padding: 12px 16px; text-align: center; font-size: 13px; font-weight: 500;
      color: #64748b; cursor: pointer; border: none; background: transparent;
      border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all 0.2s;
    }
    body .tab:hover, body.light .tab:hover { color: #475569; }
    body .tab.active, body.light .tab.active { color: #06b6d4; border-bottom-color: #06b6d4; background: rgba(6, 182, 212, 0.05); }
    body .tab-content, body.light .tab-content { display: none; padding: 20px; }
    body .tab-content.active, body.light .tab-content.active { display: block; }
    body .stats-row, body.light .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(6, 182, 212, 0.1); }
    body .stat-item, body.light .stat-item { text-align: center; padding: 10px; background: rgba(6, 182, 212, 0.06); border-radius: 8px; border: 1px solid rgba(6, 182, 212, 0.12); }
    body .stat-value, body.light .stat-value { font-size: 22px; font-weight: 600; background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    body .stat-label, body.light .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    body .form-group, body.light .form-group { margin-bottom: 14px; }
    body .form-group label, body.light .form-group label { display: block; margin-bottom: 4px; color: #475569; font-size: 12px; font-weight: 500; }
    body .form-control, body.light .form-control {
      width: 100%; padding: 10px 12px; background: rgba(248, 250, 252, 0.9); border: 1px solid rgba(6, 182, 212, 0.2);
      border-radius: 8px; font-size: 13px; color: #1e293b; font-family: 'Inter', sans-serif; transition: all 0.2s;
    }
    body .form-control::placeholder, body.light .form-control::placeholder { color: #94a3b8; }
    body .form-control:focus, body.light .form-control:focus { outline: none; border-color: #06b6d4; box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.15); }
    textarea.form-control { resize: vertical; min-height: 70px; }
    .btn {
      background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); color: #fff; border: none;
      padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 500;
      transition: all 0.2s; font-family: 'Inter', sans-serif; box-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    .btn.is-loading {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(6, 182, 212, 0.4); }
    body .btn-outline, body.light .btn-outline { background: transparent; color: #0891b2; border: 1px solid rgba(6, 182, 212, 0.4); box-shadow: none; }
    body .btn-outline:hover, body.light .btn-outline:hover { background: rgba(6, 182, 212, 0.08); transform: none; }
    body .btn-danger, body.light .btn-danger { background: transparent; color: #dc2626; border: 1px solid rgba(220, 38, 38, 0.4); box-shadow: none; }
    body .btn-danger:hover, body.light .btn-danger:hover { background: rgba(220, 38, 38, 0.08); transform: none; }
    body .btn-success, body.light .btn-success { background: transparent; color: #16a34a; border: 1px solid rgba(22, 163, 74, 0.4); box-shadow: none; }
    body .btn-success:hover, body.light .btn-success:hover { background: rgba(22, 163, 74, 0.08); transform: none; }
    body .divider, body.light .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.15), transparent); margin: 16px 0; }
    body .list-item, body.light .list-item {
      background: rgba(248, 250, 252, 0.8); border: 1px solid rgba(6, 182, 212, 0.1); border-radius: 8px;
      padding: 10px 12px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s;
    }
    body .list-item:hover, body.light .list-item:hover { border-color: rgba(6, 182, 212, 0.2); background: rgba(255, 255, 255, 0.9); }
    .item-info { flex: 1; min-width: 0; }
    body .item-primary, body.light .item-primary { display: flex; align-items: center; gap: 6px; color: #334155; font-size: 11px; margin-bottom: 2px; flex-wrap: wrap; }
    .key-text { font-family: 'JetBrains Mono', monospace; word-break: break-all; }
    .key-actions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
    body .item-secondary, body.light .item-secondary { font-size: 10px; color: #64748b; display: flex; align-items: center; gap: 4px; }
    .status-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 500; text-transform: uppercase; }
    body .status-active, body.light .status-active { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
    body .status-inactive, body.light .status-inactive { background: rgba(202, 138, 4, 0.12); color: #ca8a04; }
    body .status-invalid, body.light .status-invalid { background: rgba(220, 38, 38, 0.12); color: #dc2626; }
    .item-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 10px; }
    .item-actions .btn { padding: 5px 8px; font-size: 10px; }
    body .btn-icon, body.light .btn-icon { background: none; border: none; padding: 4px; cursor: pointer; color: #64748b; transition: color 0.2s; display: inline-flex; align-items: center; justify-content: center; }
    body .btn-icon:hover, body.light .btn-icon:hover { color: #06b6d4; }
    body .notification, body.light .notification {
      position: fixed; top: 16px; right: 16px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(8px);
      border: 1px solid rgba(6, 182, 212, 0.2); border-radius: 8px; padding: 10px 16px; display: none; z-index: 10000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); font-size: 12px;
    }
    .notification.show { display: block; animation: slideIn 0.3s ease; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    body .notification.success, body.light .notification.success { color: #16a34a; border-color: rgba(22, 163, 74, 0.3); }
    body .notification.error, body.light .notification.error { color: #dc2626; border-color: rgba(220, 38, 38, 0.3); }
    body .hint, body.light .hint { font-size: 11px; color: #64748b; margin-top: 10px; }
    body .empty-state, body.light .empty-state { text-align: center; padding: 20px; color: #64748b; font-size: 12px; }
    body .section-title, body.light .section-title { font-size: 12px; font-weight: 500; color: #475569; margin-bottom: 10px; }
    .auth-badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 500; margin-left: 8px; }
    body .auth-on, body.light .auth-on { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
    body .auth-off, body.light .auth-off { background: rgba(202, 138, 4, 0.12); color: #ca8a04; }
    body .footer, body.light .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #64748b; }
    body .footer span, body.light .footer span { color: #06b6d4; }
    body #authOverlay, body.light #authOverlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%);
      display: flex; align-items: center; justify-content: center; z-index: 9999;
    }
    body .auth-card, body.light .auth-card {
      background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px); border: 1px solid rgba(6, 182, 212, 0.15);
      border-radius: 12px; padding: 32px; max-width: 340px; width: 90%; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    body .auth-card h2, body.light .auth-card h2 { color: #1e293b; }

    /* ========== \u6697\u8272\u4E3B\u9898 ========== */
    body.dark {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      color: #e2e8f0;
    }
    body.dark h1 { color: #f1f5f9; }
    body.dark .card {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(6, 182, 212, 0.2);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    }
    body.dark .tabs { background: rgba(15, 23, 42, 0.5); }
    body.dark .tab:hover { color: #94a3b8; }
    body.dark .stat-item { background: rgba(6, 182, 212, 0.08); border: 1px solid rgba(6, 182, 212, 0.15); }
    body.dark .form-group label { color: #94a3b8; }
    body.dark .form-control {
      background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(6, 182, 212, 0.25);
      color: #e2e8f0;
    }
    body.dark .form-control::placeholder { color: #475569; }
    body.dark .form-control:focus { box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2); }
    body.dark .btn-outline { color: #06b6d4; }
    body.dark .btn-outline:hover { background: rgba(6, 182, 212, 0.1); }
    body.dark .btn-danger { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    body.dark .btn-danger:hover { background: rgba(248, 113, 113, 0.1); }
    body.dark .btn-success { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); }
    body.dark .btn-success:hover { background: rgba(74, 222, 128, 0.1); }
    body.dark .divider { background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.2), transparent); }
    body.dark .list-item {
      background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(6, 182, 212, 0.1);
    }
    body.dark .list-item:hover { border-color: rgba(6, 182, 212, 0.25); background: rgba(15, 23, 42, 0.8); }
    body.dark .item-primary { color: #cbd5e1; }
    body.dark .status-active { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    body.dark .status-inactive { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    body.dark .status-invalid { background: rgba(248, 113, 113, 0.15); color: #f87171; }
    body.dark .notification {
      background: rgba(30, 41, 59, 0.95);
      border: 1px solid rgba(6, 182, 212, 0.3);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    body.dark .notification.success { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); }
    body.dark .notification.error { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    body.dark .section-title { color: #94a3b8; }
    body.dark .auth-on { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    body.dark .auth-off { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    body.dark .footer { color: #475569; }
    body.dark #authOverlay {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
    }
    body.dark .auth-card {
      background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(6, 182, 212, 0.25);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    body.dark .auth-card h2 { color: #f1f5f9; }

    /* ========== \u4E3B\u9898\u5207\u6362\u6309\u94AE ========== */
    .theme-toggle {
      position: absolute; top: 0; right: 0;
      background: none; border: none; cursor: pointer; padding: 8px;
      color: #64748b; transition: color 0.2s;
    }
    .theme-toggle:hover { color: #06b6d4; }
    .theme-toggle svg { width: 20px; height: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <button class="theme-toggle" onclick="toggleTheme()" title="\u5207\u6362\u4E3B\u9898">
        <svg id="sunIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <svg id="moonIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path fill="#06b6d4" d="M22 4h-9.77L11 .34a.5.5 0 0 0-.5-.34H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9.65L13 23.68a.5.5 0 0 0 .47.32H22a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM7.5 15a4.5 4.5 0 1 1 2.92-7.92.5.5 0 1 1-.65.76A3.5 3.5 0 1 0 11 11H7.5a.5.5 0 0 1 0-1h4a.5.5 0 0 1 .5.5A4.5 4.5 0 0 1 7.5 15Zm11.9-4a11.26 11.26 0 0 1-1.86 3.29 6.67 6.67 0 0 1-1.07-1.48.5.5 0 0 0-.93.38 8 8 0 0 0 1.34 1.87 8.9 8.9 0 0 1-.65.62L14.62 11ZM23 22a1 1 0 0 1-1 1h-7.4l2.77-3.17a.49.49 0 0 0 .09-.48l-.91-2.66a9.36 9.36 0 0 0 1-.89c1 1 1.93 1.91 2.12 2.08a.5.5 0 0 0 .68-.74 43.48 43.48 0 0 1-2.13-2.1 11.49 11.49 0 0 0 2.22-4h1.06a.5.5 0 0 0 0-1H18V9.5a.5.5 0 0 0-1 0v.5h-2.5a.49.49 0 0 0-.21 0l-1.72-5H22a1 1 0 0 1 1 1Z"/>
        </svg>
      </div>
      <h1><span>Cerebras</span> Translator</h1>
      <p class="subtitle">\u57FA\u4E8E\u5927\u5584\u4EBA\u7684\u7FFB\u8BD1\u7528\u4E2D\u8F6C\u670D\u52A1</p>
    </div>

    <div class="card">
      <div class="tabs">
        <button class="tab active" onclick="switchTab('keys')">API \u5BC6\u94A5</button>
        <button class="tab" onclick="switchTab('models')">\u6A21\u578B\u914D\u7F6E</button>
        <button class="tab" onclick="switchTab('access')">\u8BBF\u95EE\u63A7\u5236</button>
      </div>

      <div id="keysTab" class="tab-content active">
        <div class="stats-row">
          <div class="stat-item">
            <div class="stat-value">${stats.totalKeys}</div>
            <div class="stat-label">\u603B\u5BC6\u94A5</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${stats.activeKeys}</div>
            <div class="stat-label">\u6D3B\u8DC3</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${stats.totalRequests}</div>
            <div class="stat-label">\u8BF7\u6C42\u6570</div>
          </div>
        </div>

        <div class="form-group">
          <label>\u6DFB\u52A0 Cerebras API \u5BC6\u94A5</label>
          <input type="text" id="singleKey" class="form-control" placeholder="\u8F93\u5165 Cerebras API \u5BC6\u94A5">
          <button class="btn" onclick="addSingleKey()" style="margin-top: 8px;">\u6DFB\u52A0</button>
        </div>

        <div class="divider"></div>

        <div class="form-group">
          <label>\u6279\u91CF\u5BFC\u5165</label>
          <textarea id="batchKeys" class="form-control" placeholder="\u6BCF\u884C\u4E00\u4E2A\u5BC6\u94A5"></textarea>
          <button class="btn" onclick="addBatchKeys()" style="margin-top: 8px;">\u5BFC\u5165</button>
        </div>

        <div class="divider"></div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span class="section-title" style="margin: 0;">\u5BC6\u94A5\u5217\u8868</span>
          <button class="btn btn-outline" onclick="exportAllKeys()">\u5BFC\u51FA\u5168\u90E8</button>
        </div>
        <div id="keysContainer"></div>
      </div>

      <div id="modelsTab" class="tab-content">
        <p class="hint" style="margin-top: 0; margin-bottom: 14px;">\u6A21\u578B\u6C60\u8F6E\u8BE2\uFF0C\u5206\u6563 TPM \u8D1F\u8F7D</p>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span class="section-title" style="margin: 0;">\u53EF\u7528\u6A21\u578B\u76EE\u5F55</span>
          <button class="btn btn-outline" onclick="refreshModelCatalog()" id="refreshModelCatalogBtn">\u5237\u65B0</button>
        </div>
        <p class="hint" id="modelCatalogHint" style="margin-top: 0;">\u52A0\u8F7D\u4E2D...</p>

        <div id="modelCatalogContainer"></div>
        <button class="btn" onclick="saveModelPoolFromSelection()" style="margin-top: 8px;" id="saveModelPoolBtn">\u4FDD\u5B58\u6A21\u578B\u6C60</button>
      </div>

      <div id="accessTab" class="tab-content">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <div>
            <span class="section-title" style="margin: 0;">\u4EE3\u7406\u8BBF\u95EE\u5BC6\u94A5</span>
            <span id="authBadge" class="auth-badge ${stats.proxyAuthEnabled ? "auth-on" : "auth-off"}">${stats.proxyAuthEnabled ? "\u9274\u6743\u5DF2\u5F00\u542F" : "\u516C\u5F00\u8BBF\u95EE"}</span>
          </div>
          <span style="font-size: 11px; color: #64748b;" id="keyCountLabel">${stats.proxyKeyCount}/${MAX_PROXY_KEYS}</span>
        </div>
        <p class="hint" style="margin-top: 0; margin-bottom: 14px;">\u521B\u5EFA\u5BC6\u94A5\u540E\u81EA\u52A8\u5F00\u542F\u9274\u6743\uFF1B\u5220\u9664\u6240\u6709\u5BC6\u94A5\u5219\u53D8\u4E3A\u516C\u5F00\u8BBF\u95EE</p>

        <div class="form-group">
          <label>\u5BC6\u94A5\u540D\u79F0\uFF08\u53EF\u9009\uFF09</label>
          <input type="text" id="proxyKeyName" class="form-control" placeholder="\u4F8B\u5982\uFF1A\u79FB\u52A8\u7AEF\u5E94\u7528">
          <button class="btn" onclick="createProxyKey()" style="margin-top: 8px;" id="createProxyKeyBtn">\u521B\u5EFA\u5BC6\u94A5</button>
        </div>

        <div class="divider"></div>
        <div class="section-title">\u5DF2\u521B\u5EFA\u7684\u5BC6\u94A5</div>
        <div id="proxyKeysContainer"></div>

        <div class="divider"></div>
        <div class="section-title">\u9AD8\u7EA7\u8BBE\u7F6E</div>
        <div class="form-group">
          <label>KV \u5237\u76D8\u95F4\u9694\uFF08ms\uFF09</label>
          <input type="number" id="kvFlushIntervalMs" class="form-control" min="1000" step="100" placeholder="\u4F8B\u5982 15000">
          <button class="btn btn-outline" onclick="saveKvFlushIntervalMs()" style="margin-top: 8px;">\u4FDD\u5B58</button>
          <p class="hint" id="kvFlushIntervalHint">\u6700\u5C0F 1000ms\u3002\u7528\u4E8E\u63A7\u5236\u7EDF\u8BA1/\u7528\u91CF\u5199\u56DE KV \u7684\u9891\u7387\u3002</p>
        </div>
      </div>
    </div>

    <div class="footer">Endpoint: <span>/v1/chat/completions</span></div>
    <div class="notification" id="notification"></div>
  </div>

  <div id="authOverlay">
    <div class="auth-card">
      <div style="text-align: center; margin-bottom: 20px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width: 40px; height: 40px; margin-bottom: 8px; filter: drop-shadow(0 0 12px rgba(6, 182, 212, 0.5));">
          <path fill="#06b6d4" d="M22 4h-9.77L11 .34a.5.5 0 0 0-.5-.34H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9.65L13 23.68a.5.5 0 0 0 .47.32H22a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM7.5 15a4.5 4.5 0 1 1 2.92-7.92.5.5 0 1 1-.65.76A3.5 3.5 0 1 0 11 11H7.5a.5.5 0 0 1 0-1h4a.5.5 0 0 1 .5.5A4.5 4.5 0 0 1 7.5 15Zm11.9-4a11.26 11.26 0 0 1-1.86 3.29 6.67 6.67 0 0 1-1.07-1.48.5.5 0 0 0-.93.38 8 8 0 0 0 1.34 1.87 8.9 8.9 0 0 1-.65.62L14.62 11ZM23 22a1 1 0 0 1-1 1h-7.4l2.77-3.17a.49.49 0 0 0 .09-.48l-.91-2.66a9.36 9.36 0 0 0 1-.89c1 1 1.93 1.91 2.12 2.08a.5.5 0 0 0 .68-.74 43.48 43.48 0 0 1-2.13-2.1 11.49 11.49 0 0 0 2.22-4h1.06a.5.5 0 0 0 0-1H18V9.5a.5.5 0 0 0-1 0v.5h-2.5a.49.49 0 0 0-.21 0l-1.72-5H22a1 1 0 0 1 1 1Z"/>
        </svg>
        <h2 style="color: #f1f5f9; font-size: 18px;"><span style="background: linear-gradient(135deg, #06b6d4, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Cerebras</span> Translator</h2>
      </div>
      <p id="authTitle" style="color: #94a3b8; font-size: 12px; text-align: center; margin-bottom: 20px;">\u52A0\u8F7D\u4E2D...</p>
      <div class="form-group">
        <label id="passwordLabel">\u5BC6\u7801</label>
        <input type="password" id="authPassword" class="form-control" placeholder="\u8F93\u5165\u5BC6\u7801">
      </div>
      <div id="confirmGroup" class="form-group" style="display: none;">
        <label>\u786E\u8BA4\u5BC6\u7801</label>
        <input type="password" id="authConfirm" class="form-control" placeholder="\u518D\u6B21\u8F93\u5165\u5BC6\u7801">
      </div>
      <button class="btn" id="authBtn" onclick="handleAuth()" style="width: 100%; padding: 10px; font-size: 13px;">\u63D0\u4EA4</button>
      <p id="authError" style="color: #f87171; font-size: 11px; text-align: center; margin-top: 10px; display: none;"></p>
    </div>
  </div>

  <script>
    let adminToken = localStorage.getItem('adminToken') || '';
    let authMode = 'login';
    const MAX_PROXY_KEYS = ${MAX_PROXY_KEYS};

    let currentModelPool = [];
    let modelCatalogState = null;

    // \u4E3B\u9898\u7BA1\u7406
    function loadTheme() {
      const saved = localStorage.getItem('theme') || 'light';
      document.body.className = saved;
      updateThemeIcon();
    }

    function toggleTheme() {
      const current = document.body.classList.contains('dark') ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.body.className = next;
      localStorage.setItem('theme', next);
      updateThemeIcon();
    }

    function updateThemeIcon() {
      const isDark = document.body.classList.contains('dark');
      document.getElementById('sunIcon').style.display = isDark ? 'none' : 'block';
      document.getElementById('moonIcon').style.display = isDark ? 'block' : 'none';
    }

    loadTheme();

    function getAuthHeaders() { return { 'X-Admin-Token': adminToken }; }

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tabs = ['keys', 'models', 'access'];
      const idx = tabs.indexOf(tab);
      if (idx >= 0) {
        document.querySelectorAll('.tab')[idx].classList.add('active');
        document.getElementById(tab + 'Tab').classList.add('active');
      }
    }

    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showAuthError(getApiErrorMessage(res, data));
          return;
        }
        if (!data.hasPassword) {
          authMode = 'setup';
          document.getElementById('authTitle').textContent = '\u9996\u6B21\u4F7F\u7528\uFF0C\u8BF7\u8BBE\u7F6E\u7BA1\u7406\u5BC6\u7801';
          document.getElementById('passwordLabel').textContent = '\u65B0\u5BC6\u7801\uFF08\u81F3\u5C11 4 \u4F4D\uFF09';
          document.getElementById('confirmGroup').style.display = 'block';
          document.getElementById('authBtn').textContent = '\u8BBE\u7F6E\u5BC6\u7801';
          document.getElementById('authOverlay').style.display = 'flex';
        } else if (!data.isLoggedIn) {
          authMode = 'login';
          document.getElementById('authTitle').textContent = '\u8BF7\u767B\u5F55\u4EE5\u7EE7\u7EED';
          document.getElementById('passwordLabel').textContent = '\u5BC6\u7801';
          document.getElementById('confirmGroup').style.display = 'none';
          document.getElementById('authBtn').textContent = '\u767B\u5F55';
          document.getElementById('authOverlay').style.display = 'flex';
        } else {
          document.getElementById('authOverlay').style.display = 'none';
          loadProxyKeys();
          loadKeys();
          loadModelCatalog();
          loadModels();
          loadConfig();
        }
      } catch (e) { showAuthError('\u68C0\u67E5\u767B\u5F55\u72B6\u6001\u5931\u8D25'); }
    }

    function showAuthError(msg) {
      const el = document.getElementById('authError');
      el.textContent = msg;
      el.style.display = 'block';
    }

    async function handleAuth() {
      const password = document.getElementById('authPassword').value;
      document.getElementById('authError').style.display = 'none';
      if (authMode === 'setup') {
        const confirm = document.getElementById('authConfirm').value;
        if (password.length < 4) { showAuthError('\u5BC6\u7801\u81F3\u5C11 4 \u4F4D'); return; }
        if (password !== confirm) { showAuthError('\u4E24\u6B21\u5BC6\u7801\u4E0D\u4E00\u81F4'); return; }
        try {
          const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAuthError(getApiErrorMessage(res, data) || '\u8BBE\u7F6E\u5931\u8D25');
            return;
          }
          if (data.success && data.token) { adminToken = data.token; localStorage.setItem('adminToken', adminToken); checkAuth(); }
          else showAuthError('\u8BBE\u7F6E\u5931\u8D25');
        } catch (e) { showAuthError('\u9519\u8BEF: ' + formatClientError(e)); }
      } else {
        try {
          const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAuthError(getApiErrorMessage(res, data) || '\u767B\u5F55\u5931\u8D25');
            return;
          }
          if (data.success && data.token) { adminToken = data.token; localStorage.setItem('adminToken', adminToken); checkAuth(); }
          else showAuthError('\u767B\u5F55\u5931\u8D25');
        } catch (e) { showAuthError('\u9519\u8BEF: ' + formatClientError(e)); }
      }
    }

    document.getElementById('authPassword').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') { if (authMode === 'setup') document.getElementById('authConfirm').focus(); else handleAuth(); }
    });
    document.getElementById('authConfirm')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAuth(); });

    let notificationTimer = null;
    function showNotification(message, type = 'success') {
      const notif = document.getElementById('notification');
      if (!notif) { alert(message); return; }
      if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
      }
      notif.textContent = message;
      notif.className = 'notification show ' + type;
      notif.style.display = 'block';
      notif.style.zIndex = '10000';
      notificationTimer = setTimeout(() => {
        notif.classList.remove('show');
        notif.style.display = 'none';
        notificationTimer = null;
      }, 3000);
    }

    function formatClientError(error) {
      if (!error) return '\u672A\u77E5\u9519\u8BEF';
      if (error.name === 'AbortError') return '\u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5';
      const msg = error.message || String(error);
      const lower = msg.toLowerCase();
      if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('err_connection_refused')) {
        return '\u65E0\u6CD5\u8FDE\u63A5\u5230\u672C\u5730\u670D\u52A1\uFF08' + location.origin + '\uFF09\uFF0C\u8BF7\u786E\u8BA4 Deno \u670D\u52A1\u5728\u8FD0\u884C\u4E14\u7AEF\u53E3\u53EF\u8BBF\u95EE';
      }
      return msg;
    }

    async function fetchJsonWithTimeout(url, options, timeoutMs = 15000) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const text = await res.text();
        let data = {};
        if (text) {
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
        }
        return { res, data };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function getApiErrorMessage(res, data) {
      if (data && typeof data.detail === 'string' && data.detail.trim()) return data.detail;
      if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
      if (data && typeof data.title === 'string' && data.title.trim()) return data.title;
      if (data && typeof data.message === 'string' && data.message.trim()) return data.message;
      return 'HTTP ' + res.status;
    }

    function handleUnauthorized(res) {
      if (res.status !== 401) return false;
      adminToken = '';
      localStorage.removeItem('adminToken');
      checkAuth();
      return true;
    }

    function setButtonLoading(btn, loading, text) {
      if (!btn) return;

      if (loading) {
        if (!('oldText' in btn.dataset)) {
          btn.dataset.oldText = btn.textContent || '';
        }

        const w = btn.getBoundingClientRect().width;
        if (Number.isFinite(w) && w > 0) {
          btn.dataset.oldWidth = String(w);
          btn.style.width = w + 'px';
        }

        btn.classList.add('is-loading');
        btn.textContent = text || '\u5904\u7406\u4E2D...';
        btn.disabled = true;
        return;
      }

      if ('oldText' in btn.dataset) {
        btn.textContent = btn.dataset.oldText || '';
      }

      delete btn.dataset.oldText;
      delete btn.dataset.oldWidth;
      btn.style.width = '';
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }

    // \u914D\u7F6E\u7BA1\u7406
    async function loadConfig() {
      try {
        const res = await fetch('/api/config', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u52A0\u8F7D\u914D\u7F6E\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const input = document.getElementById('kvFlushIntervalMs');
        if (input) {
          input.value = String(data.kvFlushIntervalMs ?? '');
          if (data.kvFlushIntervalMinMs) input.min = String(data.kvFlushIntervalMinMs);
        }

        const hint = document.getElementById('kvFlushIntervalHint');
        if (hint) {
          const effective = data.effectiveKvFlushIntervalMs ?? data.kvFlushIntervalMs;
          hint.textContent = '\u5F53\u524D\u751F\u6548\uFF1A' + String(effective ?? '') + 'ms';
        }
      } catch (e) {
        showNotification('\u52A0\u8F7D\u914D\u7F6E\u5931\u8D25: ' + formatClientError(e), 'error');
      }
    }

    async function saveKvFlushIntervalMs() {
      const el = document.getElementById('kvFlushIntervalMs');
      const raw = el ? el.value : '';
      const ms = Number(raw);
      const min = Number(el?.min || '1000');

      if (!Number.isFinite(ms)) {
        showNotification('\u8BF7\u8F93\u5165\u5408\u6CD5\u6570\u5B57', 'error');
        return;
      }
      if (ms < min) {
        showNotification('\u6700\u5C0F ' + String(min) + 'ms', 'error');
        return;
      }

      try {
        const res = await fetch('/api/config', {
          method: 'PATCH',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ kvFlushIntervalMs: ms }),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u4FDD\u5B58\u5931\u8D25', 'error');
          return;
        }
        showNotification('\u5DF2\u4FDD\u5B58');
        loadConfig();
      } catch (e) {
        showNotification('\u4FDD\u5B58\u5931\u8D25: ' + formatClientError(e), 'error');
      }
    }

    // \u4EE3\u7406\u5BC6\u94A5\u7BA1\u7406
    async function loadProxyKeys() {
      try {
        const res = await fetch('/api/proxy-keys', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u52A0\u8F7D\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const container = document.getElementById('proxyKeysContainer');
        const badge = document.getElementById('authBadge');
        const countLabel = document.getElementById('keyCountLabel');
        const createBtn = document.getElementById('createProxyKeyBtn');

        countLabel.textContent = (data.keys?.length || 0) + '/' + MAX_PROXY_KEYS;
        createBtn.disabled = (data.keys?.length || 0) >= MAX_PROXY_KEYS;

        if (data.authEnabled) {
          badge.className = 'auth-badge auth-on';
          badge.textContent = '\u9274\u6743\u5DF2\u5F00\u542F';
        } else {
          badge.className = 'auth-badge auth-off';
          badge.textContent = '\u516C\u5F00\u8BBF\u95EE';
        }

        if (data.keys?.length > 0) {
          container.textContent = '';

          for (const k of data.keys) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const keySpan = document.createElement('span');
            keySpan.className = 'key-text';
            keySpan.id = 'pk-' + k.id;
            keySpan.textContent = String(k.key ?? '');

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn-icon';
            toggleBtn.title = '\u67E5\u770B\u5B8C\u6574\u5BC6\u94A5';
            toggleBtn.addEventListener('click', () => toggleProxyKeyVisibility(k.id));

            const svgNs = 'http://www.w3.org/2000/svg';

            const eyeIcon = document.createElementNS(svgNs, 'svg');
            eyeIcon.id = 'pk-eye-' + k.id;
            eyeIcon.setAttribute('xmlns', svgNs);
            eyeIcon.setAttribute('width', '12');
            eyeIcon.setAttribute('height', '12');
            eyeIcon.setAttribute('viewBox', '0 0 24 24');
            eyeIcon.setAttribute('fill', 'none');
            eyeIcon.setAttribute('stroke', 'currentColor');
            eyeIcon.setAttribute('stroke-width', '2');

            const eyePath = document.createElementNS(svgNs, 'path');
            eyePath.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');

            const eyeCircle = document.createElementNS(svgNs, 'circle');
            eyeCircle.setAttribute('cx', '12');
            eyeCircle.setAttribute('cy', '12');
            eyeCircle.setAttribute('r', '3');

            eyeIcon.appendChild(eyePath);
            eyeIcon.appendChild(eyeCircle);

            const eyeOffIcon = document.createElementNS(svgNs, 'svg');
            eyeOffIcon.id = 'pk-eye-off-' + k.id;
            eyeOffIcon.setAttribute('xmlns', svgNs);
            eyeOffIcon.setAttribute('width', '12');
            eyeOffIcon.setAttribute('height', '12');
            eyeOffIcon.setAttribute('viewBox', '0 0 24 24');
            eyeOffIcon.setAttribute('fill', 'none');
            eyeOffIcon.setAttribute('stroke', 'currentColor');
            eyeOffIcon.setAttribute('stroke-width', '2');
            eyeOffIcon.style.display = 'none';

            const eyeOffPath = document.createElementNS(svgNs, 'path');
            eyeOffPath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24');

            const eyeOffLine = document.createElementNS(svgNs, 'line');
            eyeOffLine.setAttribute('x1', '1');
            eyeOffLine.setAttribute('y1', '1');
            eyeOffLine.setAttribute('x2', '23');
            eyeOffLine.setAttribute('y2', '23');

            eyeOffIcon.appendChild(eyeOffPath);
            eyeOffIcon.appendChild(eyeOffLine);

            toggleBtn.appendChild(eyeIcon);
            toggleBtn.appendChild(eyeOffIcon);

            primary.appendChild(keySpan);
            primary.appendChild(toggleBtn);

            const secondary = document.createElement('div');
            secondary.className = 'item-secondary';
            secondary.textContent = String(k.name ?? '') + ' \xB7 \u5DF2\u4F7F\u7528 ' + String(k.useCount ?? 0) + ' \u6B21';

            info.appendChild(primary);
            info.appendChild(secondary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-outline';
            copyBtn.textContent = '\u590D\u5236';
            copyBtn.addEventListener('click', () => copyProxyKey(k.id));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '\u5220\u9664';
            deleteBtn.addEventListener('click', () => deleteProxyKey(k.id));

            actions.appendChild(copyBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '\u6682\u65E0\u4EE3\u7406\u5BC6\u94A5\uFF0CAPI \u5F53\u524D\u4E3A\u516C\u5F00\u8BBF\u95EE';
          container.appendChild(empty);
        }
      } catch (e) { showNotification('\u52A0\u8F7D\u5931\u8D25: ' + formatClientError(e), 'error'); }
    }

    async function createProxyKey() {
      const name = document.getElementById('proxyKeyName').value.trim();
      try {
        const res = await fetch('/api/proxy-keys', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u521B\u5EFA\u5931\u8D25', 'error');
          return;
        }

        showNotification('\u5BC6\u94A5\u5DF2\u521B\u5EFA\uFF0C\u8BF7\u7ACB\u5373\u590D\u5236\u4FDD\u5B58');
        document.getElementById('proxyKeyName').value = '';
        loadProxyKeys();
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    async function deleteProxyKey(id) {
      if (!confirm('\u5220\u9664\u6B64\u5BC6\u94A5\uFF1F\u4F7F\u7528\u6B64\u5BC6\u94A5\u7684\u5BA2\u6237\u7AEF\u5C06\u65E0\u6CD5\u8BBF\u95EE')) return;
      try {
        const res = await fetch('/api/proxy-keys/' + id, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u5220\u9664\u5931\u8D25', 'error');
          return;
        }
        showNotification('\u5BC6\u94A5\u5DF2\u5220\u9664');
        loadProxyKeys();
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    const proxyKeyFullValues = {};
    async function toggleProxyKeyVisibility(id) {
      const keySpan = document.getElementById('pk-' + id);
      const eyeIcon = document.getElementById('pk-eye-' + id);
      const eyeOffIcon = document.getElementById('pk-eye-off-' + id);
      if (eyeIcon.style.display !== 'none') {
        if (!proxyKeyFullValues[id]) {
          try {
            const res = await fetch('/api/proxy-keys/' + id + '/export', { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (handleUnauthorized(res)) return;
            if (res.ok && data.key) proxyKeyFullValues[id] = data.key;
          } catch (e) { return; }
        }
        if (proxyKeyFullValues[id]) {
          keySpan.textContent = proxyKeyFullValues[id];
          eyeIcon.style.display = 'none';
          eyeOffIcon.style.display = 'inline';
        }
      } else { loadProxyKeys(); }
    }

    async function copyProxyKey(id) {
      try {
        const res = await fetch('/api/proxy-keys/' + id + '/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u590D\u5236\u5931\u8D25', 'error');
          return;
        }
        if (data.key) { await navigator.clipboard.writeText(data.key); showNotification('\u5BC6\u94A5\u5DF2\u590D\u5236'); }
        else showNotification('\u590D\u5236\u5931\u8D25', 'error');
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    // API \u5BC6\u94A5\u7BA1\u7406
    async function addSingleKey() {
      const key = document.getElementById('singleKey').value.trim();
      if (!key) { showNotification('\u8BF7\u8F93\u5165\u5BC6\u94A5', 'error'); return; }
      try {
        const res = await fetch('/api/keys', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u6DFB\u52A0\u5931\u8D25', 'error');
          return;
        }
        showNotification('\u5BC6\u94A5\u5DF2\u6DFB\u52A0');
        document.getElementById('singleKey').value = '';
        loadKeys();
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    async function addBatchKeys() {
      const input = document.getElementById('batchKeys').value.trim();
      if (!input) { showNotification('\u8BF7\u8F93\u5165\u5BC6\u94A5', 'error'); return; }
      try {
        const res = await fetch('/api/keys/batch', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u5BFC\u5165\u5931\u8D25', 'error');
          return;
        }
        if (data.summary) { showNotification(\`\u5BFC\u5165\u5B8C\u6210\uFF1A\${data.summary.success} \u6210\u529F\uFF0C\${data.summary.failed} \u5931\u8D25\`); document.getElementById('batchKeys').value = ''; loadKeys(); }
        else showNotification('\u5BFC\u5165\u5931\u8D25', 'error');
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    async function loadKeys() {
      try {
        const res = await fetch('/api/keys', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u52A0\u8F7D\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const container = document.getElementById('keysContainer');
        if (data.keys?.length > 0) {
          container.textContent = '';

          for (const k of data.keys) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const keySpan = document.createElement('span');
            keySpan.className = 'key-text';
            keySpan.id = 'key-' + k.id;
            keySpan.textContent = String(k.key ?? '');

            const keyActions = document.createElement('span');
            keyActions.className = 'key-actions';

            const svgNs = 'http://www.w3.org/2000/svg';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn-icon';
            toggleBtn.title = '\u67E5\u770B\u5B8C\u6574\u5BC6\u94A5';
            toggleBtn.addEventListener('click', () => toggleKeyVisibility(k.id));

            const eyeIcon = document.createElementNS(svgNs, 'svg');
            eyeIcon.id = 'eye-' + k.id;
            eyeIcon.setAttribute('xmlns', svgNs);
            eyeIcon.setAttribute('width', '14');
            eyeIcon.setAttribute('height', '14');
            eyeIcon.setAttribute('viewBox', '0 0 24 24');
            eyeIcon.setAttribute('fill', 'none');
            eyeIcon.setAttribute('stroke', 'currentColor');
            eyeIcon.setAttribute('stroke-width', '2');

            const eyePath = document.createElementNS(svgNs, 'path');
            eyePath.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');

            const eyeCircle = document.createElementNS(svgNs, 'circle');
            eyeCircle.setAttribute('cx', '12');
            eyeCircle.setAttribute('cy', '12');
            eyeCircle.setAttribute('r', '3');

            eyeIcon.appendChild(eyePath);
            eyeIcon.appendChild(eyeCircle);

            const eyeOffIcon = document.createElementNS(svgNs, 'svg');
            eyeOffIcon.id = 'eye-off-' + k.id;
            eyeOffIcon.setAttribute('xmlns', svgNs);
            eyeOffIcon.setAttribute('width', '14');
            eyeOffIcon.setAttribute('height', '14');
            eyeOffIcon.setAttribute('viewBox', '0 0 24 24');
            eyeOffIcon.setAttribute('fill', 'none');
            eyeOffIcon.setAttribute('stroke', 'currentColor');
            eyeOffIcon.setAttribute('stroke-width', '2');
            eyeOffIcon.style.display = 'none';

            const eyeOffPath = document.createElementNS(svgNs, 'path');
            eyeOffPath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24');

            const eyeOffLine = document.createElementNS(svgNs, 'line');
            eyeOffLine.setAttribute('x1', '1');
            eyeOffLine.setAttribute('y1', '1');
            eyeOffLine.setAttribute('x2', '23');
            eyeOffLine.setAttribute('y2', '23');

            eyeOffIcon.appendChild(eyeOffPath);
            eyeOffIcon.appendChild(eyeOffLine);

            toggleBtn.appendChild(eyeIcon);
            toggleBtn.appendChild(eyeOffIcon);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-icon';
            copyBtn.title = '\u590D\u5236\u5BC6\u94A5';
            copyBtn.addEventListener('click', () => copyKey(k.id));

            const copySvg = document.createElementNS(svgNs, 'svg');
            copySvg.setAttribute('xmlns', svgNs);
            copySvg.setAttribute('width', '14');
            copySvg.setAttribute('height', '14');
            copySvg.setAttribute('viewBox', '0 0 24 24');
            copySvg.setAttribute('fill', 'none');
            copySvg.setAttribute('stroke', 'currentColor');
            copySvg.setAttribute('stroke-width', '2');

            const copyRect = document.createElementNS(svgNs, 'rect');
            copyRect.setAttribute('x', '9');
            copyRect.setAttribute('y', '9');
            copyRect.setAttribute('width', '13');
            copyRect.setAttribute('height', '13');
            copyRect.setAttribute('rx', '2');
            copyRect.setAttribute('ry', '2');

            const copyPath = document.createElementNS(svgNs, 'path');
            copyPath.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

            copySvg.appendChild(copyRect);
            copySvg.appendChild(copyPath);
            copyBtn.appendChild(copySvg);

            keyActions.appendChild(toggleBtn);
            keyActions.appendChild(copyBtn);

            primary.appendChild(keySpan);
            primary.appendChild(keyActions);

            const secondary = document.createElement('div');
            secondary.className = 'item-secondary';

            const statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + String(k.status ?? '');
            statusBadge.textContent = String(k.status ?? '');

            secondary.appendChild(statusBadge);
            secondary.appendChild(document.createTextNode(' \xB7 \u5DF2\u4F7F\u7528 ' + String(k.useCount ?? 0) + ' \u6B21'));

            info.appendChild(primary);
            info.appendChild(secondary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const testBtn = document.createElement('button');
            testBtn.className = 'btn btn-success';
            testBtn.textContent = '\u6D4B\u8BD5';
            testBtn.addEventListener('click', () => testKey(k.id, testBtn));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '\u5220\u9664';
            deleteBtn.addEventListener('click', () => deleteKey(k.id));

            actions.appendChild(testBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '\u6682\u65E0 API \u5BC6\u94A5';
          container.appendChild(empty);
        }
      } catch (e) { showNotification('\u52A0\u8F7D\u5931\u8D25: ' + formatClientError(e), 'error'); }
    }

    async function copyKey(id) {
      try {
        const res = await fetch('/api/keys/' + id + '/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u590D\u5236\u5931\u8D25', 'error');
          return;
        }
        if (data.key) {
          await navigator.clipboard.writeText(data.key);
          showNotification('\u5BC6\u94A5\u5DF2\u590D\u5236');
        } else {
          showNotification('\u590D\u5236\u5931\u8D25', 'error');
        }
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    const keyFullValues = {};
    async function toggleKeyVisibility(id) {
      const keySpan = document.getElementById('key-' + id);
      const eyeIcon = document.getElementById('eye-' + id);
      const eyeOffIcon = document.getElementById('eye-off-' + id);
      if (eyeIcon.style.display !== 'none') {
        if (!keyFullValues[id]) {
          try {
            const res = await fetch('/api/keys/' + id + '/export', { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (handleUnauthorized(res)) return;
            if (res.ok && data.key) keyFullValues[id] = data.key;
          } catch (e) { return; }
        }
        if (keyFullValues[id]) { keySpan.textContent = keyFullValues[id]; eyeIcon.style.display = 'none'; eyeOffIcon.style.display = 'inline'; }
      } else { loadKeys(); }
    }

    async function deleteKey(id) {
      if (!confirm('\u5220\u9664\u6B64\u5BC6\u94A5\uFF1F')) return;
      try {
        const res = await fetch('/api/keys/' + id, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u5220\u9664\u5931\u8D25', 'error');
          return;
        }
        showNotification('\u5BC6\u94A5\u5DF2\u5220\u9664');
        loadKeys();
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    async function testKey(id, btn) {
      setButtonLoading(btn, true, '\u5728\u6D4B');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/keys/' + id + '/test', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u5BC6\u94A5\u6D4B\u8BD5\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        if (data.success) {
          showNotification('\u5BC6\u94A5\u6709\u6548', 'success');
        } else {
          const detail = data.error || data.status || (res.ok ? '' : ('HTTP ' + res.status));
          if (data.status === 'invalid') showNotification('\u5BC6\u94A5\u5931\u6548: ' + detail, 'error');
          else showNotification('\u5BC6\u94A5\u4E0D\u53EF\u7528: ' + detail, 'error');
        }
        loadKeys();
      } catch (e) {
        showNotification('\u5BC6\u94A5\u6D4B\u8BD5\u5931\u8D25: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function exportAllKeys() {
      try {
        const res = await fetch('/api/keys/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u5BFC\u51FA\u5931\u8D25', 'error');
          return;
        }
        if (data.keys?.length > 0) { await navigator.clipboard.writeText(data.keys.join('\\n')); showNotification(\`\${data.keys.length} \u4E2A\u5BC6\u94A5\u5DF2\u590D\u5236\`); }
        else showNotification('\u6CA1\u6709\u5BC6\u94A5\u53EF\u5BFC\u51FA', 'error');
      } catch (e) { showNotification('\u9519\u8BEF: ' + formatClientError(e), 'error'); }
    }

    // \u6A21\u578B\u7BA1\u7406
    function formatTimestamp(ms) {
      try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
    }

    function renderModelCatalog() {
      const container = document.getElementById('modelCatalogContainer');
      const hint = document.getElementById('modelCatalogHint');
      if (!container || !hint) return;

      const pool = Array.isArray(currentModelPool) ? currentModelPool.map(m => String(m)) : [];
      const poolSet = new Set(pool);

      const catalogModels = (modelCatalogState && Array.isArray(modelCatalogState.models))
        ? modelCatalogState.models.map(m => String(m))
        : [];
      const catalogSet = new Set(catalogModels);

      container.textContent = '';

      if (!modelCatalogState) {
        hint.textContent = '\u672A\u52A0\u8F7D\u6A21\u578B\u76EE\u5F55';
      } else {
        const fetchedAt = modelCatalogState.fetchedAt ? formatTimestamp(modelCatalogState.fetchedAt) : '';
        const stale = modelCatalogState.stale ? '\uFF1B\u76EE\u5F55\u53EF\u80FD\u8FC7\u65F6' : '';
        const lastError = modelCatalogState.lastError ? ('\uFF1B\u4E0A\u6B21\u9519\u8BEF\uFF1A' + modelCatalogState.lastError) : '';
        hint.textContent = '\u76EE\u5F55\u6A21\u578B\u6570\uFF1A' + String(catalogModels.length) + (fetchedAt ? ('\uFF1B\u66F4\u65B0\u65F6\u95F4\uFF1A' + fetchedAt) : '') + stale + lastError;
      }

      function addCheckboxRow(model, badgeText) {
        const name = String(model || '').trim();
        if (!name) return;

        const item = document.createElement('div');
        item.className = 'list-item';

        const info = document.createElement('div');
        info.className = 'item-info';

        const primary = document.createElement('div');
        primary.className = 'item-primary';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'model-pool-checkbox';
        checkbox.dataset.model = name;
        checkbox.checked = poolSet.has(name);
        checkbox.style.marginRight = '8px';

        const modelSpan = document.createElement('span');
        modelSpan.className = 'key-text';
        modelSpan.textContent = name;

        primary.appendChild(checkbox);
        primary.appendChild(modelSpan);

        if (badgeText) {
          const badge = document.createElement('span');
          badge.className = 'status-badge status-inactive';
          badge.textContent = badgeText;
          primary.appendChild(badge);
        }

        info.appendChild(primary);
        item.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const encodedName = encodeURIComponent(name);

        const testBtn = document.createElement('button');
        testBtn.className = 'btn btn-success';
        testBtn.textContent = '\u6D4B\u8BD5';
        testBtn.addEventListener('click', () => testModel(encodedName, testBtn));

        actions.appendChild(testBtn);
        item.appendChild(actions);

        container.appendChild(item);
      }

      const extras = pool.filter((m) => !catalogSet.has(m));
      if (extras.length > 0) {
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = '\u4E0D\u5728\u76EE\u5F55';
        container.appendChild(title);
        for (const m of extras) addCheckboxRow(m, '\u5DF2\u9009');

        const divider = document.createElement('div');
        divider.className = 'divider';
        container.appendChild(divider);
      }

      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = '\u76EE\u5F55\u6A21\u578B';
      container.appendChild(title);

      if (catalogModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '\u76EE\u5F55\u4E3A\u7A7A\uFF08\u53EF\u80FD\u662F\u7F51\u7EDC\u95EE\u9898\u6216\u4E0A\u6E38\u53D8\u66F4\uFF09';
        container.appendChild(empty);
        return;
      }

      for (const m of catalogModels) {
        addCheckboxRow(m, '');
      }
    }

    async function loadModelCatalog() {
      try {
        const res = await fetch('/api/models/catalog', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u52A0\u8F7D\u6A21\u578B\u76EE\u5F55\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        modelCatalogState = data;
        renderModelCatalog();
      } catch (e) {
        showNotification('\u52A0\u8F7D\u6A21\u578B\u76EE\u5F55\u5931\u8D25: ' + formatClientError(e), 'error');
      }
    }

    async function refreshModelCatalog() {
      const btn = document.getElementById('refreshModelCatalogBtn');
      setButtonLoading(btn, true, '\u5237\u65B0\u4E2D...');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/models/catalog/refresh', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u5237\u65B0\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        modelCatalogState = data;
        showNotification('\u76EE\u5F55\u5DF2\u5237\u65B0');
        renderModelCatalog();
      } catch (e) {
        showNotification('\u5237\u65B0\u5931\u8D25: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function saveModelPoolFromSelection() {
      const btn = document.getElementById('saveModelPoolBtn');
      setButtonLoading(btn, true, '\u4FDD\u5B58\u4E2D...');

      try {
        const nodes = document.querySelectorAll('.model-pool-checkbox');
        const models = [];
        const seen = new Set();

        for (const el of nodes) {
          if (!el || el.type !== 'checkbox') continue;
          if (!el.checked) continue;
          const m = String(el.dataset.model || '').trim();
          if (!m || seen.has(m)) continue;
          seen.add(m);
          models.push(m);
        }

        if (models.length === 0) {
          showNotification('\u6A21\u578B\u6C60\u4E0D\u80FD\u4E3A\u7A7A', 'error');
          return;
        }

        const res = await fetch('/api/models', {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ models }),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '\u4FDD\u5B58\u5931\u8D25', 'error');
          return;
        }

        showNotification('\u6A21\u578B\u6C60\u5DF2\u4FDD\u5B58');
        loadModels();
      } catch (e) {
        showNotification('\u4FDD\u5B58\u5931\u8D25: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function loadModels() {
      try {
        const res = await fetch('/api/models', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u52A0\u8F7D\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        currentModelPool = Array.isArray(data.models) ? data.models.map(m => String(m)) : [];
        renderModelCatalog();
      } catch (e) {
        showNotification('\u52A0\u8F7D\u5931\u8D25: ' + formatClientError(e), 'error');
      }
    }

    async function testModel(name, btn) {
      setButtonLoading(btn, true, '\u5728\u6D4B');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/models/' + name + '/test', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('\u6A21\u578B\u6D4B\u8BD5\u5931\u8D25: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        const ok = Boolean(data.success);
        const detail = data.error || data.status || (res.ok ? '' : ('HTTP ' + res.status));
        showNotification(ok ? '\u6A21\u578B\u53EF\u7528' : ('\u6A21\u578B\u4E0D\u53EF\u7528: ' + detail), ok ? 'success' : 'error');
      } catch (e) {
        showNotification('\u6A21\u578B\u6D4B\u8BD5\u5931\u8D25: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    checkAuth();
  <\/script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      ...NO_CACHE_HEADERS,
      "Content-Type": "text/html"
    }
  });
}

// deno.ts
async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (path.startsWith("/api/auth/")) {
    const response = await handleAuthRoutes(req, path);
    if (response) return response;
    return problemResponse("Not Found", {
      status: 404,
      instance: path
    });
  }
  if (path.startsWith("/api/")) {
    if (!await isAdminAuthorized(req)) {
      return problemResponse("\u672A\u767B\u5F55", {
        status: 401,
        instance: path
      });
    }
    const proxyKeyResponse = await handleProxyKeyRoutes(req, path);
    if (proxyKeyResponse) return proxyKeyResponse;
    const apiKeyResponse = await handleApiKeyRoutes(req, path);
    if (apiKeyResponse) return apiKeyResponse;
    const modelResponse = await handleModelRoutes(req, path);
    if (modelResponse) return modelResponse;
    const configResponse = await handleConfigRoutes(req, path);
    if (configResponse) return configResponse;
    return problemResponse("Not Found", {
      status: 404,
      instance: path
    });
  }
  if (req.method === "GET" && path === "/v1/models") {
    return handleModelsEndpoint(req);
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return await handleProxyEndpoint(req);
  }
  if (path === "/" && req.method === "GET") {
    return await renderAdminPage();
  }
  return new Response("Not Found", {
    status: 404
  });
}
console.log(`Cerebras Proxy \u542F\u52A8`);
console.log(`- \u7BA1\u7406\u9762\u677F: /`);
console.log(`- API \u4EE3\u7406: /v1/chat/completions`);
console.log(`- \u6A21\u578B\u63A5\u53E3: /v1/models`);
console.log(`- \u5B58\u50A8: Deno KV`);
if (import.meta.main) {
  await bootstrapCache();
  applyKvFlushInterval(cachedConfig);
  serve(handler);
}
