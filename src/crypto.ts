export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_KEY_LENGTH = 32;

const SHA256_BYTES = 32;

function bytesSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== SHA256_BYTES || b.length !== SHA256_BYTES) return false;

  let diff = 0;
  for (let index = 0; index < SHA256_BYTES; index++) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      bytesSource(new TextEncoder().encode(value)),
    ),
  );
}

export async function compareSecret(a: string, b: string): Promise<boolean> {
  const [aDigest, bDigest] = await Promise.all([
    sha256Bytes(a),
    sha256Bytes(b),
  ]);
  return constantTimeEqualBytes(aDigest, bDigest);
}

export async function hashPassword(
  password: string,
  salt?: Uint8Array,
): Promise<string> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: actualSalt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    PBKDF2_KEY_LENGTH * 8,
  );

  const derivedKey = new Uint8Array(derivedBits);
  const saltB64 = btoa(String.fromCharCode(...actualSalt));
  const keyB64 = btoa(String.fromCharCode(...derivedKey));
  return `v1$pbkdf2$${PBKDF2_ITERATIONS}$${saltB64}$${keyB64}`;
}

export async function verifyPbkdf2Password(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");

  if (!(parts.length === 5 && parts[0] === "v1" && parts[1] === "pbkdf2")) {
    return false;
  }

  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let storedKey: Uint8Array;
  try {
    salt = Uint8Array.from(atob(parts[3]), (char) => char.charCodeAt(0));
    storedKey = Uint8Array.from(atob(parts[4]), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    storedKey.length * 8,
  );

  const computedKey = new Uint8Array(derivedBits);
  if (computedKey.length !== storedKey.length) return false;

  let diff = 0;
  for (let index = 0; index < computedKey.length; index++) {
    diff |= computedKey[index] ^ storedKey[index];
  }
  return diff === 0;
}