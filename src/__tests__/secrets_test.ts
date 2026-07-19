import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertKeyEncryptionSecretConfigured,
  decryptApiKey,
  encryptApiKey,
  fingerprintApiKey,
  hashProxyKey,
  isApiKeyFingerprint,
  isEncryptedApiKey,
  isHashedProxyKey,
  verifyProxyKey,
} from "../secrets.ts";

Deno.test("secrets - encrypts API keys without storing plaintext", async () => {
  Deno.env.set("KEY_ENCRYPTION_SECRET", "unit-secret");

  const encrypted = await encryptApiKey("sk-unit-secret");

  assertEquals(isEncryptedApiKey(encrypted), true);
  assertEquals(encrypted.includes("sk-unit-secret"), false);
  assertEquals(await decryptApiKey(encrypted), "sk-unit-secret");
});

Deno.test("secrets - derives stable deployment-scoped fingerprints", async () => {
  Deno.env.set("KEY_ENCRYPTION_SECRET", "unit-secret-a");
  const first = await fingerprintApiKey("sk-unit-secret");
  const second = await fingerprintApiKey("sk-unit-secret");

  Deno.env.set("KEY_ENCRYPTION_SECRET", "unit-secret-b");
  const otherDeployment = await fingerprintApiKey("sk-unit-secret");

  assertEquals(first, second);
  assertEquals(first !== otherDeployment, true);
  assertEquals(first.includes("sk-unit-secret"), false);
  assertEquals(isApiKeyFingerprint(first), true);
  assertEquals(isApiKeyFingerprint("v1$api-key-hmac-sha256$bad"), false);
});

Deno.test("secrets - fails fast when encryption secret is missing", async () => {
  Deno.env.delete("KEY_ENCRYPTION_SECRET");

  await assertRejects(
    () => encryptApiKey("sk-unit-secret"),
    Error,
    "KEY_ENCRYPTION_SECRET 未配置",
  );
  await assertRejects(
    () => fingerprintApiKey("sk-unit-secret"),
    Error,
    "KEY_ENCRYPTION_SECRET 未配置",
  );
});

Deno.test("secrets - validates startup encryption secret", () => {
  Deno.env.delete("KEY_ENCRYPTION_SECRET");

  assertThrows(
    () => assertKeyEncryptionSecretConfigured(),
    Error,
    "KEY_ENCRYPTION_SECRET 未配置",
  );
});

Deno.test("secrets - hashes proxy keys for verification", async () => {
  Deno.env.set("KEY_ENCRYPTION_SECRET", "unit-secret");

  const hash = await hashProxyKey("cpk_unit_secret");

  assertEquals(isHashedProxyKey(hash), true);
  assertEquals(hash.includes("cpk_unit_secret"), false);
  assertEquals(await verifyProxyKey("cpk_unit_secret", hash), true);
  assertEquals(await verifyProxyKey("cpk_wrong", hash), false);
});

Deno.test("secrets - rejects malformed proxy key hashes", async () => {
  Deno.env.set("KEY_ENCRYPTION_SECRET", "unit-secret");

  await assertRejects(
    () => verifyProxyKey("cpk_unit_secret", "v1$hmac-sha256$not-base64!"),
    Error,
    "proxy key 哈希格式错误",
  );
});