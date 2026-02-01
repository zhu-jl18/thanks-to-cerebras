import {
  ADMIN_PASSWORD_KEY,
  ADMIN_TOKEN_EXPIRY_MS,
  ADMIN_TOKEN_PREFIX,
} from "./constants.ts";
import { hashPassword, verifyPbkdf2Password } from "./crypto.ts";
import { cachedProxyKeys, dirtyProxyKeyIds, kv } from "./state.ts";

// Admin password management
export async function getAdminPassword(): Promise<string | null> {
  const entry = await kv.get<string>(ADMIN_PASSWORD_KEY);
  return entry.value;
}

export async function setAdminPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await kv.set(ADMIN_PASSWORD_KEY, hash);
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const stored = await getAdminPassword();
  if (!stored) return false;
  return await verifyPbkdf2Password(password, stored);
}

// Admin token management
export async function createAdminToken(): Promise<string> {
  const token = crypto.randomUUID();
  const expiry = Date.now() + ADMIN_TOKEN_EXPIRY_MS;
  await kv.set([...ADMIN_TOKEN_PREFIX, token], expiry);
  return token;
}

export async function verifyAdminToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const entry = await kv.get<number>([...ADMIN_TOKEN_PREFIX, token]);
  if (!entry.value) return false;
  if (Date.now() > entry.value) {
    await kv.delete([...ADMIN_TOKEN_PREFIX, token]);
    return false;
  }
  return true;
}

export async function deleteAdminToken(token: string): Promise<void> {
  await kv.delete([...ADMIN_TOKEN_PREFIX, token]);
}

export async function isAdminAuthorized(req: Request): Promise<boolean> {
  const token = req.headers.get("X-Admin-Token");
  return await verifyAdminToken(token);
}

// Proxy authorization
export function isProxyAuthorized(
  req: Request,
): { authorized: boolean; keyId?: string } {
  if (cachedProxyKeys.size === 0) {
    return { authorized: true };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { authorized: false };
  }

  const token = authHeader.substring(7).trim();
  for (const [id, pk] of cachedProxyKeys) {
    if (pk.key === token) {
      return { authorized: true, keyId: id };
    }
  }

  return { authorized: false };
}

export function recordProxyKeyUsage(keyId: string): void {
  const pk = cachedProxyKeys.get(keyId);
  if (!pk) return;
  pk.useCount++;
  pk.lastUsed = Date.now();
  dirtyProxyKeyIds.add(keyId);
}
