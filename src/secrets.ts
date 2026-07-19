const API_KEY_CIPHERTEXT_PREFIX = "v1$aes-gcm$";
const API_KEY_FINGERPRINT_PREFIX = "v1$api-key-hmac-sha256$";
const PROXY_KEY_PREFIX = "v1$hmac-sha256$";
const SHA256_BYTES = 32;

const encoder = new TextEncoder();
const API_KEY_FINGERPRINT_SALT = encoder.encode(
  "thanks-to-cerebras/api-key-store",
);
const API_KEY_FINGERPRINT_INFO = encoder.encode(
  "api-key-fingerprint/v1",
);

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function bytesSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(bytes);
}

function secretMaterial(): Uint8Array {
  const secret = Deno.env.get("KEY_ENCRYPTION_SECRET")?.trim();
  if (!secret) {
    throw new Error("KEY_ENCRYPTION_SECRET 未配置，禁止写入或读取密钥");
  }
  return encoder.encode(secret);
}

export function assertKeyEncryptionSecretConfigured(): void {
  secretMaterial();
}

async function deriveAesKey(): Promise<CryptoKey> {
  const material = secretMaterial();
  const digest = await crypto.subtle.digest("SHA-256", bytesSource(material));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function deriveProxyHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytesSource(secretMaterial()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function deriveApiKeyFingerprintKey(): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    bytesSource(secretMaterial()),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const keyMaterial = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytesSource(API_KEY_FINGERPRINT_SALT),
      info: bytesSource(API_KEY_FINGERPRINT_INFO),
    },
    rootKey,
    SHA256_BYTES * 8,
  );
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export function isEncryptedApiKey(value: string): boolean {
  return value.startsWith(API_KEY_CIPHERTEXT_PREFIX);
}

export function isApiKeyFingerprint(value: string): boolean {
  const parts = value.split("$");
  if (
    parts.length !== 3 || parts[0] !== "v1" ||
    parts[1] !== "api-key-hmac-sha256"
  ) {
    return false;
  }
  try {
    return decodeBase64Url(parts[2]).byteLength === SHA256_BYTES;
  } catch {
    return false;
  }
}

export function isHashedProxyKey(value: string): boolean {
  return value.startsWith(PROXY_KEY_PREFIX);
}

function decodeProxyKeyHash(storedHash: string): Uint8Array {
  const parts = storedHash.split("$");
  if (
    parts.length !== 3 || parts[0] !== "v1" || parts[1] !== "hmac-sha256"
  ) {
    throw new Error("proxy key 哈希格式错误");
  }
  try {
    return decodeBase64Url(parts[2]);
  } catch (error) {
    if (error instanceof DOMException) {
      throw new Error("proxy key 哈希格式错误");
    }
    throw error;
  }
}

export async function encryptApiKey(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey();
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      bytesSource(encoder.encode(plaintext)),
    ),
  );
  return `${API_KEY_CIPHERTEXT_PREFIX}${encodeBase64Url(iv)}$${
    encodeBase64Url(ciphertext)
  }`;
}

export async function decryptApiKey(stored: string): Promise<string> {
  if (!isEncryptedApiKey(stored)) {
    throw new Error("API key 存储格式不兼容：密文版本无效");
  }

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "aes-gcm") {
    throw new Error("API key 密文格式错误");
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesSource(decodeBase64Url(parts[2])) },
    await deriveAesKey(),
    bytesSource(decodeBase64Url(parts[3])),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Produces a deterministic, deployment-scoped blind index for API-key
 * plaintext. The HMAC key is derived from the root secret with HKDF and a
 * dedicated context, so the fingerprint cannot be used as a general-purpose
 * hash or correlated across deployments with different secrets.
 */
export async function fingerprintApiKey(plaintext: string): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await deriveApiKeyFingerprintKey(),
      bytesSource(encoder.encode(plaintext)),
    ),
  );
  return `${API_KEY_FINGERPRINT_PREFIX}${encodeBase64Url(signature)}`;
}

async function hashProxyKeyBytes(secret: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await deriveProxyHmacKey(),
      bytesSource(encoder.encode(secret)),
    ),
  );
}

export async function hashProxyKey(secret: string): Promise<string> {
  const signature = await hashProxyKeyBytes(secret);
  return `${PROXY_KEY_PREFIX}${encodeBase64Url(signature)}`;
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const maxLength = Math.max(a.byteLength, b.byteLength);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < maxLength; i++) {
    const left = i < a.byteLength ? a[i] : 0;
    const right = i < b.byteLength ? b[i] : 0;
    diff |= left ^ right;
  }
  return diff === 0;
}

export async function verifyProxyKey(
  secret: string,
  storedHash: string,
): Promise<boolean> {
  if (!isHashedProxyKey(storedHash)) {
    throw new Error("proxy key 存储格式不兼容：需要先运行密钥迁移");
  }
  const expected = await hashProxyKeyBytes(secret);
  return constantTimeEqualBytes(expected, decodeProxyKeyHash(storedHash));
}