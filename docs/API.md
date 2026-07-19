# API 文档

> 📖 相关文档：[README](../README.md) | [部署指南](GUIDE.md) |
> [技术细节](TECH_DETAILS.md)

## 0. 约定

- Base URL：`https://<your-project>.deno.dev`
- 对外代理接口（`/v1/*`）支持开放
  CORS（`Access-Control-Allow-Origin: *`）；管理接口（`/api/*`）的 JSON 响应与
  OPTIONS 预检不返回 `Access-Control-Allow-Origin`，浏览器跨域请求会被拦截。
- `OPTIONS` 预检请求统一返回 `204`。
- JSON 响应默认带 `Cache-Control: no-store`（用于避免缓存敏感数据/统计）。

> 管理 API（`/api/*`）的非 2xx 错误采用 Problem Details：
>
> - `Content-Type: application/problem+json`
> - Body: `{ type, title, status, detail, instance? }`

## 1. 鉴权模型

### 1.1 管理面板 / 管理 API

- Header：`X-Admin-Token: <token>`
- token 获取方式见 `/api/auth/login` / `/api/auth/setup`
- token 有效期默认 7 天（服务端过期后需重新登录）

### 1.2 代理 API（OpenAI 兼容入口）

- 默认必须携带代理密钥：
  - Header：`Authorization: Bearer <proxy_key>`
- 当管理面板显式开启公开访问时，可不携带代理密钥。

## 2. OpenAI 兼容代理接口（对外）

### 2.1 `GET /v1/models`

- 描述：返回对外暴露的“虚拟模型”列表。
- 响应：OpenAI 风格的 `list`。

### 2.2 `POST /v1/chat/completions`

- 描述：将 OpenAI 风格的 Chat Completions 请求代理到 Cerebras。
- 行为：
  - 会把请求体的 `model` 字段覆盖为模型池轮询得到的真实模型
  - 请求体读取前会检查 `Content-Length`，并限制实际 body 字节数
  - 会校验关键 Chat Completions 字段，限制 messages 数量、content 长度和
    `max_tokens`
  - 成功流式响应会直接透传上游 response body
  - 上游非 2xx 响应不会透传原始 body 或诊断 header，只返回统一错误结构
  - 代理请求会通过 Deno KV atomic/TTL 执行全局、单代理密钥和未授权请求限流
  - 上游响应流受总时长、idle、响应字节数和并发 stream 限制
  - 若上游返回 `404` 且错误为
    `model_not_found`，代理会把该模型从模型池中移除（持久化到
    KV），并立刻切换到下一个模型重试（最多 `3` 次）

常见响应码：

- `401`：代理访问未授权（没带/带错 Bearer
  token，或未创建代理密钥且未开启公开访问）
- `400`：请求 JSON 或 Chat Completions 关键字段非法
- `413`：请求体超过大小限制
- `429`：代理限流命中、并发流式请求过多，或当前没有可用 API
  key（全部处于冷却/不可用等）；限流响应包含 `Retry-After`

## 3. 管理鉴权 API（无需先登录）

### 3.1 `GET /api/auth/status`

- Header（可选）：`X-Admin-Token`
- 响应：
  - `hasPassword: boolean`：是否已设置管理密码
  - `isLoggedIn: boolean`：token 是否有效

### 3.2 `POST /api/auth/setup`

- 描述：首次设置管理密码（只能调用一次；已设置则返回错误）。
- Header：`X-Setup-Token: <SETUP_TOKEN>`
- Content-Type：`application/json`
- 请求体：`{ "password": string }`
- 响应：`{ "success": true, "token": string }`

### 3.3 `POST /api/auth/login`

- Content-Type：`application/json`
- 请求体：`{ "password": string }`
- 响应：`{ "success": true, "token": string }`

### 3.4 `POST /api/auth/logout`

- Header：`X-Admin-Token`
- 响应：`{ "success": true }`

### 3.5 `POST /api/auth/reset-password`

- 描述：用 `SETUP_TOKEN` 重置管理密码。**故意不**接受旧密码作为凭证——旧密码一旦泄露就无法挽回，所以恢复通道走部署侧独享的 `SETUP_TOKEN`。
- Header：`X-Setup-Token: <SETUP_TOKEN>`
- Content-Type：`application/json`
- 请求体：`{ "password": string }`，密码长度 ≥ 8
- 行为：
  - 直接覆盖写入新密码哈希
  - 撤销所有现存 admin token（包括调用方的旧 token）
  - 给调用方签一个新 token 返回，便于直接登录
  - 与 `/api/auth/login` 共用 admin-auth 限流桶，廉价校验失败的请求**不会**消耗桶
- 响应：`{ "success": true, "token": string }`
- 推荐操作流程：用完后立刻把 Deno Deploy 上的 `SETUP_TOKEN` env 删掉或改成废值，关闸到下次需要恢复时再开。

## 4. 管理 API（需要登录）

> 以下接口都需要 Header：`X-Admin-Token`

### 4.1 代理访问密钥（Proxy Keys）

- `GET /api/proxy-keys`
  - 返回：密钥元数据列表（不包含明文
    key）、`maxKeys`、`authEnabled`、`proxyPublicAccess`
- `POST /api/proxy-keys`
  - 请求体：`{ "name": string }`（可选）
  - 成功：返回新创建的密钥（返回体中会包含一次性明文 key）
- `DELETE /api/proxy-keys/<id>`
- `GET /api/proxy-keys/<id>/export`
  - 返回 `403`；代理密钥只在创建时显示一次
- `POST /api/proxy-keys/migrate`
  - 将旧 KV 中明文 proxy key 迁移为 HMAC 哈希存储

### 4.2 Cerebras API 密钥（API Keys）

API key 使用随机资源 ID 管理；明文经 AES-GCM 加密，另以部署作用域的 HMAC
blind fingerprint 建立唯一 claim。主记录和 claim 在同一个 Deno KV atomic
事务中创建或删除，因此多实例和 stale cache 场景下仍保持同值唯一性。

- `GET /api/keys`
  - 返回：密钥元数据列表（不包含明文 key）
  - 若 record/claim 存储 invariant 不成立，返回服务端错误而不是跳过损坏记录
- `POST /api/keys`
  - 请求体：`{ "key": string }`
  - 同值 key 已存在时返回 `409`
- `POST /api/keys/batch`
  - Content-Type 支持：`application/json` 或纯文本
  - 返回：导入结果汇总（部分成功/失败）
- `DELETE /api/keys/<id>`
  - 删除主记录和唯一 claim；冲突返回 `409`，存储 invariant 损坏返回 `500`
- `POST /api/keys/<id>/test`
  - 描述：测活单个 key（会访问上游）
  - 注意：该操作会更新 KV 内该 key 的 `status`
- `GET /api/keys/export`
  - 返回 `403`；明文导出已禁用
- `GET /api/keys/<id>/export`
  - 返回 `403`；明文导出已禁用

当前 API-key store 不提供旧 schema 迁移端点。升级到该 schema 前需要清空旧 API-key
记录并通过管理 API 重新导入，避免部分索引状态在运行时被静默接受。

### 4.3 模型池（Models）

模型目录（Catalog）：

- `GET /api/models/catalog`
  - 描述：从 Cerebras public models API 拉取并缓存“可用模型列表”。
  - 返回：`models`、`fetchedAt`、`ttlMs`、`stale`、`lastError?`
- `POST /api/models/catalog/refresh`
  - 描述：强制刷新模型目录。

模型池（Pool）：

- `GET /api/models`
  - 返回：
    - `models: string[]`：配置的模型池
- `PUT /api/models`
  - 描述：一次性更新模型池（会去重/trim）。
  - 请求体：`{ "models": string[] }`
- `POST /api/models/<name>/test`
  - 描述：用当前某个 active key 对指定模型做一次上游请求

### 4.4 统计与配置

- `GET /api/stats`
- `GET /api/config`
  - 返回配置（包含 KV 刷盘相关字段：`kvFlushIntervalMs` /
    `effectiveKvFlushIntervalMs` / `kvFlushIntervalMinMs`）
- `PATCH /api/config`
  - 请求体：`{ "kvFlushIntervalMs": number }`
  - 用途：更新 KV 刷盘间隔（会被钳制到最小值）
