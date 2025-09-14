# Cerebras API 转发 for 沉浸式翻译

> 代码来源： [linux.do](https://linux.do/t/topic/956453) 


## 🚀 快速部署

### 🍳 详细步骤

1.  **获取 Cerebras Key**: 
     * 点击 [Cerebras官网](https://www.cerebras.ai/) 找右上角。
1.  **部署到 Deno**:
    *   打开 [Deno Deploy](https://dash.deno.com/) 并新建`Playground`。
    *   把`deno.ts` 的代码粘贴进去。
2.  **配置环境变量**:
    *   添加 `CEREBRAS_API_KEYS`。
    *   值填写 Cerebras Key，多个用英文逗号 `,` 分隔，不要留空。
3.  **配置沉浸式翻译**:
    *   **API Key**: 任意填写。
    *   **上游地址**: `https://<你的Deno项目名>.deno.dev/v1/chat/completions`。
    *   **模型**: `gpt-oss-120b` 或 `qwen-3-235b-a22b-instruct-2507`。

### 📸 配置截图

<div align="center">
  <p>Deno Deploy 配置</p>
  <img src="image/配置说明1.png" alt="Deno Deploy" width="70%">
</div>
<div align="center">
  <p>沉浸式翻译配置</p>
  <img src="image/配置说明2.png" alt="沉浸式翻译" width="70%">
</div>

## ✨ 未来计划

- to do 
  - [ ] Docker 支持
  - [ ] 技术原理解析
  - [ ] 模型自动轮换
  - [ ] 简单鉴权





