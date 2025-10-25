# Cerebras KV 持久化部署指南 v2.1

## 核心要点
- 服务入口是 `deno_ui_ultra.ts`，部署到 Deno Deploy 即完成后端与前端一体化交付。
- 所有密钥与配置持久化在 Deno KV，轮询逻辑通过 KV 原子事务保证并发安全。
- 管理面板默认开放；代理鉴权通过可选环境变量 `AUTH_PASSWORD` 控制。
- 部署完成后同时提供 `/` 管理界面、`/v1/chat/completions` 代理和 `/v1/models` 列表接口。

## 前置准备
- Deno Deploy 账号：https://dash.deno.com/ 注册并登录。
- 最新版 `deno_ui_ultra.ts`：确保使用仓库当前版本。
- Cerebras API 密钥若干，确认可用。
- 可选代理口令：若需对外限制访问，预先决定 `AUTH_PASSWORD`。

## 部署流程
### 1. 创建或选择项目
- 在 Deno Deploy 控制台点击 “New Project”，选择 “Deploy from Dashboard”。
- 若复用旧项目，先确认无历史 KV 数据需求；旧版本数据无法自动迁移。

### 2. 粘贴源码
- 将 `deno_ui_ultra.ts` 整体拷贝到在线编辑器。
- 保存后点击 “Deploy” 触发首次发布。

### 3. 配置环境变量（可选）
- 在 “Settings > Environment Variables” 中追加：
  - `AUTH_PASSWORD=<自定义代理口令>` （设定后，所有 `/v1/*` 请求需要携带 `Authorization: Bearer <口令>`；未设置时无需鉴权）
- 保存并重新部署，使配置生效。

### 4. 验证部署
- 访问日志页面，应看到类似输出：
  ```
  🚀 Cerebras 密钥管理系统启动 (KV 持久化版 v2.0)
  - 管理面板: 主页
  - API 代理: /v1/chat/completions
  - 默认模型接口: /v1/models
  - 请求间隔: 200ms
  - 存储方式: Deno KV 持久化存储
  ```
- 浏览器打开 `https://<project>.deno.dev/`，确认 UI 正常渲染。

## 运行与维护
- **密钥管理**：在“密钥管理”面板中新增、批量导入、测试或删除；所有写操作即时落到 Deno KV。
- **轮询策略**：轮询指针与使用计数在原子事务里同步更新，避免并发覆盖；无需额外锁配置。
- **模型管理**：在“默认模型”区域更新后，后端自动刷新 `defaultModel` 并保持统计字段不回滚。
- **代理鉴权**：若设置 `AUTH_PASSWORD`，记得在客户端请求头中使用 `Authorization: Bearer <口令>`。
- **日志追踪**：Deno Deploy 控制台中查看 `Functions -> Logs`；每次请求记录当前密钥和远端状态码。

## 请求流示意
```text
Client -> /v1/chat/completions -> Deno Proxy -> Cerebras API
        <- JSON Response      <-            <- 
```

## 常见问题处理
- **提示“没有可用的 API 密钥”**：至少保留一个状态为 `active` 的密钥，并确认最近未集中删除。
- **模型更新无效**：刷新浏览器缓存后重试；若仍失败检查日志中是否有原子更新重试上限错误。
- **并发请求重复使用同一密钥**：升级到本版本后即通过 KV 原子事务消除该问题，出现时检查是否部署了旧代码。
- **返回 401 Unauthorized**：确认已设置 `AUTH_PASSWORD`，并检查客户端是否携带 `Authorization: Bearer <口令>`。

## 下一步
- 在客户端配置 `apiBase=https://<project>.deno.dev/v1`。
- 若启用 `AUTH_PASSWORD`，在客户端设置 `Authorization: Bearer <口令>`；未启用时该头可省略。
- 通过 `/api/stats` 或 UI 仪表板监控调用量与密钥健康状况。
