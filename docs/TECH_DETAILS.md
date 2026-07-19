# 技术细节

> 📖 相关文档：[README](../README.md) | [部署指南](GUIDE.md) |
> [API 文档](API.md)

## 架构概述

```
Client -> /v1/chat/completions -> Deno Proxy -> Cerebras API
       <- 流式响应             <-             <-
```

## 三层密钥体系

1. **管理员密码** - 登录管理面板
2. **代理访问密钥** - 控制谁能调用代理 API（最多 5 个）
3. **Cerebras API 密钥** - 调用上游 Cerebras API

## 密钥存储

`KEY_ENCRYPTION_SECRET` 是密钥存储根密钥：

- Cerebras API key 使用 AES-GCM 加密后写入
  KV，热路径只在内存缓存中保存解密后的值。
- 同一根密钥经 HKDF 以 `api-key-fingerprint/v1` 上下文派生独立 HMAC key；
  `HMAC-SHA-256(plaintext)` 作为部署作用域的 blind fingerprint。
- 每个 API-key 主记录都带 immutable fingerprint，并由一个
  `fingerprint -> random id` 唯一 claim 配对。创建和删除在同一个 Deno KV
  atomic 事务中更新两者，相当于 `UNIQUE(fingerprint)` 约束。
- 代理访问密钥只在创建响应中返回一次，KV 中只保存 HMAC-SHA-256 哈希。
- 明文导出接口返回 `403`。

API-key store 采用严格 schema，不执行在线迁移或部分自愈。旧 API-key 记录、缺失
claim、悬空 claim 或 fingerprint/ciphertext 不匹配都会被视为存储 invariant
损坏；部署前应清空旧 API-key 数据并通过管理 API 重新导入。更换根密钥会同时改变
密文解密域和 fingerprint 域，因此不支持同一 store 内的新旧根密钥混合轮换。

## API-key store invariant

对每个 API key，存储必须满足一一对应：

```text
record[id].fingerprint == fp
unique[fp] == id
HMAC(decrypt(record[id].encryptedKey)) == fp
```

正常 CRUD 均为 O(1)：

- 创建：CAS 空 record slot、空 unique claim 和 cache revision，原子写入三者。
- 删除：从主记录直接读取 fingerprint，CAS record、claim 和 revision，原子删除前两者。
- 更新：只更新主记录元数据；fingerprint、ciphertext 和 claim ownership 不变。
- 多实例添加同值 key 时竞争同一个 claim slot，只有一个事务成功。

全量 `list` 和 cache refresh 会用 cache revision 包围 record/claim 两次 prefix scan；
扫描期间发生结构性 CRUD 时会重试，只有 revision 稳定的结果才进入双向 invariant
校验和并行解密。单记录 CRUD 在发现 claim 不匹配时会复查主记录 versionstamp，区分
正常并发删除、需要重试的并发更新和真正的存储损坏。若最终 invariant 不成立，系统
保留最后一次已验证的内存缓存并记录错误，而不是跳过损坏项后继续运行。

实现按职责分层：`api-key-store-schema.ts` 只拥有 tuple 与 invariant 校验，
`api-key-store-operations.ts` 只拥有原子 CRUD 与并发分类，`api-key-store.ts` 是窄接口
facade；代理侧的选 key、强制刷新与无可用 key 策略集中在 `proxy-api-key.ts`，不混入
上游请求编排。

## 鉴权逻辑

代理访问密钥存储在 KV，默认拒绝未授权访问。只有显式开启公开访问时，才允许无
Bearer token 调用代理。

```typescript
async function isProxyAuthorized(req: Request) {
  if (cachedConfig.proxyPublicAccess) return { authorized: true };

  const token = req.headers.get("Authorization")?.substring(7);
  const keyId = await findProxyKeyIdBySecret(token);
  return keyId ? { authorized: true, keyId } : { authorized: false };
}
```

## 模型池轮询

- 对外暴露虚拟模型名 `cerebras-translator`（见 `GET /v1/models`）
- 内部按 Round-Robin 选择真实模型
- 轮询游标持久化到 KV
- 若遇到上游 `404 model_not_found`，会把该模型从模型池中移除（持久化到
  KV），并切换到下一个模型重试（最多 3 次）

## 代理请求边界

- `Content-Length` 和实际读取 body 都受最大字节数限制。
- Chat Completions 只接受关键字段的安全子集：`messages` 必须为非空数组，role
  只能是 `system` / `user` / `assistant` / `tool`，content 和 `max_tokens`
  有上限。
- 成功响应保持流式透传；上游非 2xx 响应会丢弃或限长读取
  body，只向客户端返回统一错误结构和白名单响应头。

## 流式响应生命周期

上游 2xx response body 会被包装后再返回给客户端：

- 总时长、idle 间隔和累计响应字节数都有限制，超限时取消上游 reader
  并释放并发槽。
- 客户端断开会触发 wrapper `cancel()`，同步取消上游 body。
- 并发槽使用 KV atomic/TTL 计数，包含全局桶和单代理密钥桶；公开访问使用固定
  public 桶。

## 分布式限流

所有限流桶都存储在 Deno KV，使用 atomic check/set 更新并设置 TTL，因此多
isolate、冷启动和多区域部署不会各自拥有独立内存窗口。

- 管理 setup/login 保持一个固定全局桶，不信任可伪造的 forwarded IP 头。
- 代理入口同时检查全局桶、单代理密钥桶和未授权请求桶。
- 限流命中返回 `429`，并带 `Retry-After`。

## KV 数据结构

```typescript
// 配置
[KV_PREFIX, "meta", "config"] -> ProxyConfig {
  modelPool: string[],
  currentModelIndex: number,
  totalRequests: number,
  kvFlushIntervalMs: number,
  proxyPublicAccess: boolean
}

// 管理员密码
[KV_PREFIX, "meta", "admin_password"] -> string (PBKDF2 hash, v1$pbkdf2$...)

// Cerebras API-key 主记录
[KV_PREFIX, "keys", "api", <random-id>] -> PersistedApiKey {
  id, fingerprint, encryptedKey, useCount, lastUsed, status, createdAt
}

// Cerebras API-key 唯一 claim
[KV_PREFIX, "keys", "api_unique", "v1", <fingerprint>] -> <random-id>

// 代理访问密钥
[KV_PREFIX, "keys", "proxy", <id>] -> ProxyAuthKey {
  id, keyHash, name, useCount, lastUsed, createdAt
}

// 限流桶
[KV_PREFIX, "rate-limit", <namespace>, <bucket>] -> {
  count, resetAt
}

// 流式并发槽
[KV_PREFIX, "stream", <namespace>, <bucket>] -> {
  count
}
```

升级到当前版本后，如果 KV 中仍是旧 API-key schema 或旧配置结构（如包含
`schemaVersion` / `disabledModels` 或缺少必填字段），服务会在启动时直接报错；
需要先清空 KV（本地/Docker 删除 `kv.sqlite3`，Deno Deploy 清空项目 KV 数据）
再重启并重新导入 API keys。

## 性能优化

1. **内存缓存** - 热路径不读 KV，直接读内存
2. **O(1) API-key CRUD** - 唯一 claim 消除删除时的 prefix scan 与逐条解密
3. **批量刷盘** - 统计信息按间隔批量写入 KV
4. **流式透传** - 不消费上游响应，直接透传

## KV 写入量估算

默认每 15 秒 flush 一次，写入次数约为：

- `U + P + 1`（U=脏 API 密钥数，P=脏代理密钥数，1=config）

个人项目（5-10 keys，每天用 1 小时）通常在免费额度内。

## 本地运行

本地运行时 KV 默认存储在 `src/.deno-kv-local/kv.sqlite3`，可通过 `KV_PATH`
指定目录（通过检测 `DENO_DEPLOYMENT_ID` 判断是否为 Deno Deploy）。
