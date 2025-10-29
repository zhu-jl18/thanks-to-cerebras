# WARP.md

这个文件为 WARP (warp.dev) 在此仓库中工作时提供指导。

## 项目概述

这是一个 Cerebras API 代理转发项目，专为沉浸式翻译设计。通过代理机制将翻译请求路由至 Cerebras 免费 AI 推理服务，支持多 API 密钥轮换和请求限流。

**核心特性：**
- 三个部署版本：基础版、增强版（支持鉴权+模型映射）、Ultra 持久化版（KV 管理面板）
- API 密钥池管理与轮询
- 请求限流（200ms 间隔）
- 可选密码鉴权
- 模型名称自动映射
- 流式响应保持

## 架构说明

### 代码结构

```
.
├── deno.ts              # 基础版代理（环境变量配置）
├── deno_new.ts          # 增强版代理（鉴权+模型映射）
├── deno_ui_ultra.ts     # Ultra 持久化版（Deno KV + Web 管理面板）
├── README.md            # 用户文档
├── KV_DEPLOYMENT_GUIDE.md  # Ultra 版部署指南
└── .claude/             # Claude Code 配置
```

### 三个版本对比

| 功能 | deno.ts | deno_new.ts | deno_ui_ultra.ts |
|------|---------|-------------|------------------|
| 密钥轮换 | ✅ | ✅ | ✅ |
| 请求限流 | ✅ | ✅ | ✅ |
| 鉴权保护 | ❌ | ✅ 可选 | ✅ 可选 |
| 模型映射 | ❌ | ✅ | ✅ |
| 持久化存储 | ❌ | ❌ | ✅ Deno KV |
| Web 管理面板 | ❌ | ❌ | ✅ |

### 关键技术要点

**1. 密钥轮换机制**
- 基础版和增强版：内存轮询，重启后从头开始
- Ultra 版：Deno KV 原子事务确保并发安全，持久化轮询指针

**2. 请求限流**
- 所有版本：200ms 处理间隔避免速率限制
- 基础版/增强版：`setInterval` + 请求队列
- Ultra 版：无队列设计，直接转发

**3. 模型映射**
- 增强版：硬编码默认模型 `qwen-3-235b-a22b-instruct-2507`
- Ultra 版：从 KV 读取可配置的 `defaultModel`

**4. 鉴权方式**
- 环境变量 `AUTH_PASSWORD`：设置后强制 Bearer token 验证
- Ultra 版 `/api/*` 管理接口：无需鉴权（假定部署环境私有）

## 常用命令

### 本地开发

```bash
# 运行基础版（需要先设置环境变量）
$env:CEREBRAS_API_KEYS="key1,key2,key3"
deno run --allow-net --allow-env deno.ts

# 运行增强版（可选鉴权）
$env:CEREBRAS_API_KEYS="key1,key2,key3"
$env:AUTH_PASSWORD="your-password"
deno run --allow-net --allow-env deno_new.ts

# 运行 Ultra 版（需要 KV 权限）
$env:AUTH_PASSWORD="your-password"  # 可选
deno run --allow-net --allow-env --unstable-kv deno_ui_ultra.ts
```

### 部署

此项目设计为部署到 **Deno Deploy**，不需要本地构建或打包：

1. 访问 https://dash.deno.com/
2. 创建新项目（"New Project" → "Deploy from Dashboard"）
3. 复制对应版本的 `.ts` 文件内容到在线编辑器
4. 配置环境变量（基础版/增强版需要 `CEREBRAS_API_KEYS`）
5. 点击 "Deploy" 完成部署

## API 接口说明

### 代理接口（所有版本）

- **POST** `/v1/chat/completions` - OpenAI 兼容的 Chat Completions 接口
  - 鉴权：如设置 `AUTH_PASSWORD`，需携带 `Authorization: Bearer <password>`
  - 请求体：标准 OpenAI Chat API 格式
  - 响应：流式或非流式 JSON

### 管理接口（仅 Ultra 版）

- **GET** `/` - Web 管理面板首页
- **GET** `/v1/models` - 返回默认模型信息（OpenAI 兼容）
- **GET** `/api/keys` - 获取密钥列表（掩码显示）
- **POST** `/api/keys` - 添加单个密钥
- **POST** `/api/keys/batch` - 批量导入密钥（换行/逗号/空格分隔）
- **DELETE** `/api/keys/:id` - 删除指定密钥
- **POST** `/api/keys/:id/test` - 测试密钥有效性
- **GET** `/api/stats` - 获取统计信息
- **GET** `/api/config` - 获取当前配置
- **PUT** `/api/config/default-model` - 更新默认模型

## 配置与环境变量

### 必需环境变量（基础版/增强版）

- `CEREBRAS_API_KEYS` - Cerebras API 密钥列表，逗号分隔

### 可选环境变量（所有版本）

- `AUTH_PASSWORD` - 代理鉴权密码，不设置则无需鉴权

### Ultra 版特殊说明

- 密钥池和默认模型通过 Web 管理面板持久化到 Deno KV
- 首次部署后无需 `CEREBRAS_API_KEYS` 环境变量
- Deno Deploy 自动提供 KV 存储，本地测试可指定 `DENO_KV_PATH`

## 故障排查

### 基础版/增强版

- **"No API keys configured"**: 检查 `CEREBRAS_API_KEYS` 环境变量是否设置
- **401 Unauthorized**: 检查 `AUTH_PASSWORD` 是否设置，客户端是否正确携带 Bearer token
- **请求卡住**: 检查请求队列是否堆积，考虑增加 `RATE_LIMIT_MS`

### Ultra 版

- **"没有可用的 API 密钥"**: 至少保留一个状态为 `active` 的密钥
- **模型更新无效**: 刷新浏览器缓存，检查 Deno Deploy 日志
- **并发请求重复使用密钥**: 确认使用 v2.0+ 版本（KV 原子事务）

## 开发约定

### 代码规范

- 使用 TypeScript
- Deno 标准库使用稳定版本 (std@0.192.0 或 std@0.208.0)
- CORS 头统一在 `CORS_HEADERS` 常量中定义
- 错误处理统一返回 JSON 格式 `{ error: string }`

### 敏感信息处理

- **绝不在代码中硬编码密钥**
- 密钥显示时使用 `maskApiKey()` 掩码处理
- `.gitignore` 已配置排除 `keys.txt`、`.env*` 等敏感文件
- Claude Code 权限已配置禁止 git 操作（参见 `.claude/settings.local.json`）

### KV 数据结构（Ultra 版）

```typescript
// 配置键
[KV_PREFIX, "meta", "config"] → ProxyConfig {
  defaultModel: string,
  currentKeyIndex: number,
  totalRequests: number,
  schemaVersion: string
}

// 密钥键
[KV_PREFIX, "keys", "api", <uuid>] → ApiKey {
  id: string,
  key: string,
  useCount: number,
  lastUsed?: number,
  status: 'active' | 'inactive' | 'invalid',
  createdAt: number
}
```

## 扩展开发

### 添加新模型支持

1. **基础版**: 不支持模型映射，需在客户端直接指定 Cerebras 支持的模型
2. **增强版**: 修改 `DEFAULT_MODEL` 常量（第 5 行）
3. **Ultra 版**: 通过 Web 面板或 API `/api/config/default-model` 更新

### 修改请求限流策略

所有版本的 `RATE_LIMIT_MS` 常量定义了请求间隔（默认 200ms）。修改后重新部署即可。

### 集成其他 AI 服务

如需支持其他 API 提供商，需修改：
- `CEREBRAS_API_URL` 常量
- 请求头中的 `Authorization` 格式
- 响应体解析逻辑（如果不兼容 OpenAI 格式）

## 相关资源

- Cerebras 官网: https://www.cerebras.ai/
- Deno Deploy 文档: https://deno.com/deploy
- 原始社区分享: https://linux.do/t/topic/956453
- 沉浸式翻译插件: 需配置 `上游地址` 为代理 URL

## 免责声明

本项目仅供个人学习和研究使用，代码由 Claude Code 自动生成。使用者需遵守 Cerebras 服务条款，禁止商业用途，自行承担使用风险。
