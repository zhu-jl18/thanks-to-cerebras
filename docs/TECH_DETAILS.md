# 技术细节

## 架构概述

```
Client -> /v1/chat/completions -> Deno Proxy -> Cerebras API
       <- 流式响应             <-             <-
```

## 三层密钥体系

1. **管理员密码** - 登录管理面板
2. **代理访问密钥** - 控制谁能调用代理 API（最多 5 个）
3. **Cerebras API 密钥** - 调用上游 Cerebras API

## 鉴权逻辑

代理访问密钥存储在 KV，逻辑如下：

```typescript
function isProxyAuthorized(req: Request) {
  // 无代理密钥 -> 公开访问
  if (cachedProxyKeys.size === 0) return { authorized: true };

  // 有代理密钥 -> 验证 Bearer token
  const token = req.headers.get("Authorization")?.substring(7);
  for (const pk of cachedProxyKeys.values()) {
    if (pk.key === token) return { authorized: true, keyId: pk.id };
  }
  return { authorized: false };
}
```

## 模型池轮询

- 对外暴露虚拟模型名 `cerebras-translator`（见 `GET /v1/models`）
- 内部按 Round-Robin 选择真实模型
- 轮询游标持久化到 KV
- 若遇到上游 `404 model_not_found`，会把该模型从模型池中移除（持久化到 KV），并切换到下一个模型重试（最多 3 次）

## KV 数据结构

```typescript
// 配置
[KV_PREFIX, "meta", "config"] -> ProxyConfig {
  modelPool: string[],
  currentModelIndex: number,
  totalRequests: number,
  kvFlushIntervalMs: number,
  schemaVersion: '5.0'
}

// 管理员密码
[KV_PREFIX, "meta", "admin_password"] -> string (PBKDF2 hash, v1$pbkdf2$...)

// Cerebras API 密钥
[KV_PREFIX, "keys", "api", <id>] -> ApiKey {
  id, key, useCount, lastUsed, status, createdAt
}

// 代理访问密钥
[KV_PREFIX, "keys", "proxy", <id>] -> ProxyAuthKey {
  id, key, name, useCount, lastUsed, createdAt
}
```

## 性能优化

1. **内存缓存** - 热路径不读 KV，直接读内存
2. **批量刷盘** - 统计信息按间隔批量写入 KV
3. **流式透传** - 不消费上游响应，直接透传

## KV 写入量估算

默认每 15 秒 flush 一次，写入次数约为：

- `U + P + 1`（U=脏 API 密钥数，P=脏代理密钥数，1=config）

个人项目（5-10 keys，每天用 1 小时）通常在免费额度内。

## 本地运行

本地运行时 KV 自动存储在 `.deno-kv-local/kv.sqlite3`（通过检测
`DENO_DEPLOYMENT_ID` 判断环境）。
