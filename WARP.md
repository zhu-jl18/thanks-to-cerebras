# WARP.md

WARP (warp.dev) 在此仓库中工作时的指导。

## 项目概述

Cerebras API 代理转发项目，支持多 API 密钥轮询、代理访问密钥分发、模型池轮询。

**核心特性：**
- Deno KV 持久化存储
- Web 管理面板
- 代理访问密钥动态鉴权（最多 5 个）
- Cerebras API 密钥池轮询
- 模型池轮询

## 代码结构

```
.
├── deno.ts              # 主程序
├── README.md            # 用户文档
├── TECH_DETAILS.md      # 技术细节
├── KV_DEPLOYMENT_GUIDE.md  # 部署指南
└── .claude/             # Claude Code 配置
```

## 本地开发

```bash
deno run --allow-net --allow-env --unstable-kv deno.ts
```

KV 数据存储在 `./kv.sqlite3`。

## API 接口

### 代理接口
- `POST /v1/chat/completions` - OpenAI 兼容
- `GET /v1/models` - 模型列表

### 鉴权接口
- `GET /api/auth/status` - 检查登录状态
- `POST /api/auth/setup` - 首次设置密码
- `POST /api/auth/login` - 登录
- `POST /api/auth/logout` - 登出

### 管理接口（需 X-Admin-Token）
- `GET/POST/DELETE /api/proxy-keys` - 代理密钥管理
- `GET/POST/DELETE /api/keys` - Cerebras API 密钥管理
- `GET/POST/DELETE /api/models` - 模型池管理
- `GET /api/stats` - 统计信息
- `GET /api/config` - 配置信息

## 环境变量

- `KV_FLUSH_INTERVAL_MS` - 统计刷盘间隔（默认 15000ms）

## KV 数据结构

```typescript
[KV_PREFIX, "meta", "config"] -> ProxyConfig
[KV_PREFIX, "meta", "admin_password"] -> string
[KV_PREFIX, "keys", "api", <id>] -> ApiKey
[KV_PREFIX, "keys", "proxy", <id>] -> ProxyAuthKey
[KV_PREFIX, "auth", "token", <token>] -> number (expiry)
```

## 开发约定

- TypeScript
- Deno 标准库 std@0.208.0
- 错误返回 `{ error: string }`
- 密钥显示使用 `maskKey()` 掩码

## 相关资源

- Cerebras: https://www.cerebras.ai/
- Deno Deploy: https://deno.com/deploy
