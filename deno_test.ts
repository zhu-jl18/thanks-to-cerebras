import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  hashPassword,
  PBKDF2_ITERATIONS,
  verifyPbkdf2Password,
} from "./src/crypto.ts";
import { generateProxyKey } from "./src/keys.ts";

// ================================
// 测试用例
// ================================

Deno.test("generateProxyKey - 格式和长度", () => {
  const key = generateProxyKey();

  // 检查前缀
  assertEquals(key.startsWith("cpk_"), true, "密钥应以 cpk_ 开头");

  // 检查长度（cpk_ = 4 字符 + base64url 编码的 24 字节 = 32 字符，总共 36）
  assertEquals(key.length, 36, "密钥长度应为 36 字符");

  // 检查字符集（base64url: A-Z, a-z, 0-9, -, _）
  assertMatch(key, /^cpk_[A-Za-z0-9_-]+$/, "密钥应只包含 base64url 字符");
});

Deno.test("generateProxyKey - 唯一性", () => {
  const keys = new Set<string>();
  const count = 1000;

  for (let i = 0; i < count; i++) {
    keys.add(generateProxyKey());
  }

  assertEquals(keys.size, count, "生成的密钥应该是唯一的");
});

Deno.test("hashPassword - 版本化格式", async () => {
  const password = "test123";
  const hash = await hashPassword(password);

  // 检查格式：v1$pbkdf2$<iters>$<salt_b64>$<key_b64>
  const parts = hash.split("$");
  assertEquals(parts.length, 5, "哈希应包含 5 个部分");
  assertEquals(parts[0], "v1", "版本应为 v1");
  assertEquals(parts[1], "pbkdf2", "算法应为 pbkdf2");
  assertEquals(
    parts[2],
    String(PBKDF2_ITERATIONS),
    `迭代次数应为 ${PBKDF2_ITERATIONS}`,
  );

  // 检查 salt 和 key 是否为有效 base64
  assert(parts[3].length > 0, "盐不应为空");
  assert(parts[4].length > 0, "密钥不应为空");
});

Deno.test("hashPassword - 相同密码不同盐产生不同哈希", async () => {
  const password = "test123";
  const hash1 = await hashPassword(password);
  const hash2 = await hashPassword(password);

  assertEquals(hash1 !== hash2, true, "相同密码应产生不同哈希（不同盐）");
});

Deno.test("verifyPbkdf2Password - 正确密码验证成功", async () => {
  const password = "mypassword";
  const hash = await hashPassword(password);
  const result = await verifyPbkdf2Password(password, hash);

  assertEquals(result, true, "正确密码应验证成功");
});

Deno.test("verifyPbkdf2Password - 错误密码验证失败", async () => {
  const password = "mypassword";
  const hash = await hashPassword(password);
  const result = await verifyPbkdf2Password("wrongpassword", hash);

  assertEquals(result, false, "错误密码应验证失败");
});

Deno.test("verifyPbkdf2Password - 格式错误的哈希拒绝", async () => {
  const invalidHashes = [
    "invalid",
    "v1$pbkdf2$100000", // 缺少部分
    "v2$pbkdf2$100000$salt$key", // 错误版本
    "v1$sha256$100000$salt$key", // 错误算法
  ];

  for (const hash of invalidHashes) {
    const result = await verifyPbkdf2Password("anypassword", hash);
    assertEquals(result, false, `格式错误的哈希应拒绝：${hash}`);
  }
});

Deno.test("verifyPbkdf2Password - 确定性验证（相同输入相同结果）", async () => {
  const password = "test123";
  const salt = new Uint8Array(16).fill(42); // 固定盐
  const hash = await hashPassword(password, salt);

  // 多次验证应得到相同结果
  const result1 = await verifyPbkdf2Password(password, hash);
  const result2 = await verifyPbkdf2Password(password, hash);
  const result3 = await verifyPbkdf2Password(password, hash);

  assertEquals(result1, true);
  assertEquals(result2, true);
  assertEquals(result3, true);
});
