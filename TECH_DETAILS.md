# 技术细节（v4 模型池轮询版）

## TL;DR
- `/v1/models` 是给 OpenAI 风格客户端看的“可选模型列表”。v4 对外只暴露一个虚拟模型：`cerebras-translator`。
- `/v1/chat/completions` 会忽略请求端传入的 `model`，始终按内部 `modelPool` 做 Round-Robin 轮询并转发到 Cerebras。
- 统计（`totalRequests` / `useCount` / `lastUsed`）默认会写入 KV，但不影响 Cerebras token 配额；可能影响 Deno KV 的写入额度。对个人项目（5~10 keys、每天用 1 小时左右）通常问题不大。

## 1. /v1/models：对外“虚拟模型名”，对内轮询真实模型池
### 1.1 为什么只返回一个模型
很多 OpenAI 兼容客户端会先 GET `/v1/models`，再把用户选择的 model 带到 `/v1/chat/completions`。

v4 内部已经决定：真实模型由代理层轮询选择。此时如果把真实模型池暴露给客户端：
- 客户端会误以为需要“手动选模型”
- 与“代理强制覆盖 model”逻辑语义冲突

因此最佳实践是：对外只暴露一个稳定的虚拟模型名，内部再做映射/轮询。

### 1.2 行为示意（ASCII）
```text
+--------+              +----------------+                 +-------------+
| Client |              | Deno Proxy v4  |                 | Cerebras API |
+--------+              +----------------+                 +-------------+
    | GET /v1/models            |                                 |
    |-------------------------->|                                 |
    |<---- [cerebras-translator]|                                 |
    |
    | POST /v1/chat/completions (model=任意)                       |
    |-------------------------->|                                 |
    |                           |  轮询选择 modelPool 中的模型      |
    |                           |-------------------------------->| 
    |                           |<--------------------------------|
    |<--------------------------|                                 |
```

结论：
- 客户端“只能看到” `cerebras-translator`
- 客户端“发什么 model 都行”，代理都会接收并覆盖为内部轮询目标

## 2. 模型轮询与持久化（KV）
### 2.1 配置项
模型池配置持久化在 KV 的 config 中：
- `modelPool: string[]`：真实可轮询模型列表
- `currentModelIndex: number`：轮询游标（下一次要使用的 index）

### 2.2 轮询策略
- Round-Robin：每个请求取 `modelPool[currentModelIndex]`，然后 `currentModelIndex++` 循环。

### 2.3 持久化语义
- 每次请求会在内存里推进 `currentModelIndex`，并标记 config dirty。
- 按 `KV_FLUSH_INTERVAL_MS`（默认 5000ms）批量写回 KV。

注意：这类“批量刷盘”持久化是 **最终一致** 的：
- 正常情况下重启后轮询进度会接近重启前状态
- 若异常退出，可能丢失最后一个 flush 周期内的进度（通常可接受）

## 3. 统计会不会重置？写 KV 有什么影响？
### 3.1 统计字段
- 全局：`totalRequests`
- 单 key：`useCount`、`lastUsed`

### 3.2 重置策略
当前实现不会自动按小时/按天清零：
- 会持续累加
- 只有你手动清空 KV（例如新建 Deploy 项目/清数据）或加“重置接口”才会重置

### 3.3 为什么要写入 KV
写入 KV 的价值：
- 重启后统计不丢（便于排障/观察 key 轮询是否均匀）
- 便于 UI 面板展示（/api/stats）

对代理正确性来说它不是必需的；但对可观测性很有用。

### 3.4 会不会影响 Deno 免费额度
- 这些统计不会影响 Cerebras 的 token 配额（那是上游 API 的计费/额度）
- 可能影响 Deno KV 的写入额度（因为会定期 `kv.set`）

KV 写入只会在“有请求 + 有 dirty 数据”时发生；没有请求时 flush 会直接 return，不产生写入。

## 4. KV 写入量粗估（给你建立直觉）
默认每 5 秒 flush 一次。

每个 flush 周期内，写入次数大致是：
- `U + 1`
  - `U`：这 5 秒内被用到过的 key 数量（dirtyKeyIds）
  - `+1`：config（totalRequests / currentModelIndex 等）

个人项目常见：5~10 个 key、每天用 1 小时左右。
- 5 keys：最坏 `6 次写入/5s` ≈ 72 次/分钟 ≈ 4320 次/小时
- 10 keys：最坏 `11 次写入/5s` ≈ 132 次/分钟 ≈ 7920 次/小时

通常实际会更低（取决于真实请求量、5 秒内是否轮到所有 key）。

如果你未来 key 规模变大或担心 KV 写入额度：
- 保持默认 `KV_FLUSH_INTERVAL_MS=5000` 先跑（大多数人没问题）
- 需要时可把 `KV_FLUSH_INTERVAL_MS` 调大（比如 30000/60000）
- 或设为 `0` 关闭刷盘（统计将不持久化，重启后会回退/丢失）
