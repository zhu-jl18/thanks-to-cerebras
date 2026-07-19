import { kvAddKey } from "../kv/api-keys.ts";

/**
 * Persists a valid API-key record/claim pair through the public KV facade and
 * returns its random resource id.
 */
export async function addTestApiKey(plaintext: string): Promise<string> {
  const result = await kvAddKey(plaintext);
  if (!result.ok) {
    throw new Error(`failed to add test API key: ${result.code}`);
  }
  return result.id;
}
