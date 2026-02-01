import { MAX_PROXY_KEYS, NO_CACHE_HEADERS } from "../constants.ts";
import { cachedProxyKeys } from "../state.ts";
import { kvGetAllKeys, kvGetConfig } from "../kv.ts";

export async function renderAdminPage(): Promise<Response> {
  const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
  const proxyKeyCount = cachedProxyKeys.size;
  const stats = {
    totalKeys: keys.length,
    activeKeys: keys.filter((k) => k.status === "active").length,
    totalRequests: config.totalRequests,
    proxyAuthEnabled: proxyKeyCount > 0,
    proxyKeyCount,
  };

  const faviconDataUri =
    `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzA2YjZkNCIgZD0iTTIyIDRoLTkuNzdMMTEgLjM0YS41LjUgMCAwIDAtLjUtLjM0SDJhMiAyIDAgMCAwLTIgMnYxNmEyIDIgMCAwIDAgMiAyaDkuNjVMMTMgMjMuNjhhLjUuNSAwIDAgMCAuNDcuMzJIMjJhMiAyIDAgMCAwIDItMlY2YTIgMiAwIDAgMC0yLTJaTTcuNSAxNWE0LjUgNC41IDAgMSAxIDIuOTItNy45Mi41LjUgMCAxIDEtLjY1Ljc2QTMuNSAzLjUgMCAxIDAgMTEgMTFINy41YS41LjUgMCAwIDEgMC0xaDRhLjUuNSAwIDAgMSAuNS41QTQuNSA0LjUgMCAwIDEgNy41IDE1Wm0xMS45LTRhMTEuMjYgMTEuMjYgMCAwIDEtMS44NiAzLjI5IDYuNjcgNi42NyAwIDAgMS0xLjA3LTEuNDguNS41IDAgMCAwLS45My4zOCA4IDggMCAwIDAgMS4zNCAxLjg3IDguOSA4LjkgMCAwIDEtLjY1LjYyTDE0LjYyIDExWk0yMyAyMmExIDEgMCAwIDEtMSAxaC03LjRsMi43Ny0zLjE3YS40OS40OSAwIDAgMCAuMDktLjQ4bC0uOTEtMi42NmE5LjM2IDkuMzYgMCAwIDAgMS0uODljMSAxIDEuOTMgMS45MSAyLjEyIDIuMDhhLjUuNSAwIDAgMCAuNjgtLjc0IDQzLjQ4IDQzLjQ4IDAgMCAxLTIuMTMtMi4xIDExLjQ5IDExLjQ5IDAgMCAwIDIuMjItNGgxLjA2YS41LjUgMCAwIDAgMC0xSDE4VjkuNWEuNS41IDAgMCAwLTEgMHYuNWgtMi41YS40OS40OSAwIDAgMC0uMjEgMGwtMS43Mi01SDIyYTEgMSAwIDAgMSAxIDFaIi8+PC9zdmc+`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cerebras Translator</title>
  <link rel="icon" type="image/svg+xml" href="${faviconDataUri}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* ========== 亮色主题（默认） ========== */
    body, body.light {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%);
      min-height: 100vh;
      padding: 40px 20px;
      color: #1e293b;
      transition: background 0.3s, color 0.3s;
    }
    body .container, body.light .container { max-width: 600px; margin: 0 auto; }
    body .header, body.light .header { text-align: center; margin-bottom: 24px; position: relative; }
    body .logo, body.light .logo { width: 48px; height: 48px; margin: 0 auto 12px; filter: drop-shadow(0 0 16px rgba(6, 182, 212, 0.5)); }
    body h1, body.light h1 { font-size: 22px; font-weight: 600; color: #1e293b; margin-bottom: 4px; }
    body h1 span, body.light h1 span { background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    body .subtitle, body.light .subtitle { font-size: 13px; color: #64748b; }
    body .card, body.light .card {
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(6, 182, 212, 0.15);
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
      overflow: hidden;
    }
    body .tabs, body.light .tabs { display: flex; border-bottom: 1px solid rgba(6, 182, 212, 0.15); background: rgba(248, 250, 252, 0.8); }
    body .tab, body.light .tab {
      flex: 1; padding: 12px 16px; text-align: center; font-size: 13px; font-weight: 500;
      color: #64748b; cursor: pointer; border: none; background: transparent;
      border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all 0.2s;
    }
    body .tab:hover, body.light .tab:hover { color: #475569; }
    body .tab.active, body.light .tab.active { color: #06b6d4; border-bottom-color: #06b6d4; background: rgba(6, 182, 212, 0.05); }
    body .tab-content, body.light .tab-content { display: none; padding: 20px; }
    body .tab-content.active, body.light .tab-content.active { display: block; }
    body .stats-row, body.light .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(6, 182, 212, 0.1); }
    body .stat-item, body.light .stat-item { text-align: center; padding: 10px; background: rgba(6, 182, 212, 0.06); border-radius: 8px; border: 1px solid rgba(6, 182, 212, 0.12); }
    body .stat-value, body.light .stat-value { font-size: 22px; font-weight: 600; background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    body .stat-label, body.light .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    body .form-group, body.light .form-group { margin-bottom: 14px; }
    body .form-group label, body.light .form-group label { display: block; margin-bottom: 4px; color: #475569; font-size: 12px; font-weight: 500; }
    body .form-control, body.light .form-control {
      width: 100%; padding: 10px 12px; background: rgba(248, 250, 252, 0.9); border: 1px solid rgba(6, 182, 212, 0.2);
      border-radius: 8px; font-size: 13px; color: #1e293b; font-family: 'Inter', sans-serif; transition: all 0.2s;
    }
    body .form-control::placeholder, body.light .form-control::placeholder { color: #94a3b8; }
    body .form-control:focus, body.light .form-control:focus { outline: none; border-color: #06b6d4; box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.15); }
    textarea.form-control { resize: vertical; min-height: 70px; }
    .btn {
      background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); color: #fff; border: none;
      padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 500;
      transition: all 0.2s; font-family: 'Inter', sans-serif; box-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    .btn.is-loading {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(6, 182, 212, 0.4); }
    body .btn-outline, body.light .btn-outline { background: transparent; color: #0891b2; border: 1px solid rgba(6, 182, 212, 0.4); box-shadow: none; }
    body .btn-outline:hover, body.light .btn-outline:hover { background: rgba(6, 182, 212, 0.08); transform: none; }
    body .btn-danger, body.light .btn-danger { background: transparent; color: #dc2626; border: 1px solid rgba(220, 38, 38, 0.4); box-shadow: none; }
    body .btn-danger:hover, body.light .btn-danger:hover { background: rgba(220, 38, 38, 0.08); transform: none; }
    body .btn-success, body.light .btn-success { background: transparent; color: #16a34a; border: 1px solid rgba(22, 163, 74, 0.4); box-shadow: none; }
    body .btn-success:hover, body.light .btn-success:hover { background: rgba(22, 163, 74, 0.08); transform: none; }
    body .divider, body.light .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.15), transparent); margin: 16px 0; }
    body .list-item, body.light .list-item {
      background: rgba(248, 250, 252, 0.8); border: 1px solid rgba(6, 182, 212, 0.1); border-radius: 8px;
      padding: 10px 12px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s;
    }
    body .list-item:hover, body.light .list-item:hover { border-color: rgba(6, 182, 212, 0.2); background: rgba(255, 255, 255, 0.9); }
    .item-info { flex: 1; min-width: 0; }
    body .item-primary, body.light .item-primary { display: flex; align-items: center; gap: 6px; color: #334155; font-size: 11px; margin-bottom: 2px; flex-wrap: wrap; }
    .key-text { font-family: 'JetBrains Mono', monospace; word-break: break-all; }
    .key-actions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
    body .item-secondary, body.light .item-secondary { font-size: 10px; color: #64748b; display: flex; align-items: center; gap: 4px; }
    .status-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 500; text-transform: uppercase; }
    body .status-active, body.light .status-active { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
    body .status-inactive, body.light .status-inactive { background: rgba(202, 138, 4, 0.12); color: #ca8a04; }
    body .status-invalid, body.light .status-invalid { background: rgba(220, 38, 38, 0.12); color: #dc2626; }
    .item-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 10px; }
    .item-actions .btn { padding: 5px 8px; font-size: 10px; }
    body .btn-icon, body.light .btn-icon { background: none; border: none; padding: 4px; cursor: pointer; color: #64748b; transition: color 0.2s; display: inline-flex; align-items: center; justify-content: center; }
    body .btn-icon:hover, body.light .btn-icon:hover { color: #06b6d4; }
    body .notification, body.light .notification {
      position: fixed; top: 16px; right: 16px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(8px);
      border: 1px solid rgba(6, 182, 212, 0.2); border-radius: 8px; padding: 10px 16px; display: none; z-index: 10000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); font-size: 12px;
    }
    .notification.show { display: block; animation: slideIn 0.3s ease; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    body .notification.success, body.light .notification.success { color: #16a34a; border-color: rgba(22, 163, 74, 0.3); }
    body .notification.error, body.light .notification.error { color: #dc2626; border-color: rgba(220, 38, 38, 0.3); }
    body .hint, body.light .hint { font-size: 11px; color: #64748b; margin-top: 10px; }
    body .empty-state, body.light .empty-state { text-align: center; padding: 20px; color: #64748b; font-size: 12px; }
    body .section-title, body.light .section-title { font-size: 12px; font-weight: 500; color: #475569; margin-bottom: 10px; }
    .auth-badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 500; margin-left: 8px; }
    body .auth-on, body.light .auth-on { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
    body .auth-off, body.light .auth-off { background: rgba(202, 138, 4, 0.12); color: #ca8a04; }
    body .footer, body.light .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #64748b; }
    body .footer span, body.light .footer span { color: #06b6d4; }
    body #authOverlay, body.light #authOverlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #f8fafc 100%);
      display: flex; align-items: center; justify-content: center; z-index: 9999;
    }
    body .auth-card, body.light .auth-card {
      background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px); border: 1px solid rgba(6, 182, 212, 0.15);
      border-radius: 12px; padding: 32px; max-width: 340px; width: 90%; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    body .auth-card h2, body.light .auth-card h2 { color: #1e293b; }

    /* ========== 暗色主题 ========== */
    body.dark {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      color: #e2e8f0;
    }
    body.dark h1 { color: #f1f5f9; }
    body.dark .card {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(6, 182, 212, 0.2);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    }
    body.dark .tabs { background: rgba(15, 23, 42, 0.5); }
    body.dark .tab:hover { color: #94a3b8; }
    body.dark .stat-item { background: rgba(6, 182, 212, 0.08); border: 1px solid rgba(6, 182, 212, 0.15); }
    body.dark .form-group label { color: #94a3b8; }
    body.dark .form-control {
      background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(6, 182, 212, 0.25);
      color: #e2e8f0;
    }
    body.dark .form-control::placeholder { color: #475569; }
    body.dark .form-control:focus { box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2); }
    body.dark .btn-outline { color: #06b6d4; }
    body.dark .btn-outline:hover { background: rgba(6, 182, 212, 0.1); }
    body.dark .btn-danger { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    body.dark .btn-danger:hover { background: rgba(248, 113, 113, 0.1); }
    body.dark .btn-success { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); }
    body.dark .btn-success:hover { background: rgba(74, 222, 128, 0.1); }
    body.dark .divider { background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.2), transparent); }
    body.dark .list-item {
      background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(6, 182, 212, 0.1);
    }
    body.dark .list-item:hover { border-color: rgba(6, 182, 212, 0.25); background: rgba(15, 23, 42, 0.8); }
    body.dark .item-primary { color: #cbd5e1; }
    body.dark .status-active { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    body.dark .status-inactive { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    body.dark .status-invalid { background: rgba(248, 113, 113, 0.15); color: #f87171; }
    body.dark .notification {
      background: rgba(30, 41, 59, 0.95);
      border: 1px solid rgba(6, 182, 212, 0.3);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    body.dark .notification.success { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); }
    body.dark .notification.error { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    body.dark .section-title { color: #94a3b8; }
    body.dark .auth-on { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    body.dark .auth-off { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    body.dark .footer { color: #475569; }
    body.dark #authOverlay {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
    }
    body.dark .auth-card {
      background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(6, 182, 212, 0.25);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    body.dark .auth-card h2 { color: #f1f5f9; }

    /* ========== 主题切换按钮 ========== */
    .theme-toggle {
      position: absolute; top: 0; right: 0;
      background: none; border: none; cursor: pointer; padding: 8px;
      color: #64748b; transition: color 0.2s;
    }
    .theme-toggle:hover { color: #06b6d4; }
    .theme-toggle svg { width: 20px; height: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <button class="theme-toggle" onclick="toggleTheme()" title="切换主题">
        <svg id="sunIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <svg id="moonIcon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path fill="#06b6d4" d="M22 4h-9.77L11 .34a.5.5 0 0 0-.5-.34H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9.65L13 23.68a.5.5 0 0 0 .47.32H22a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM7.5 15a4.5 4.5 0 1 1 2.92-7.92.5.5 0 1 1-.65.76A3.5 3.5 0 1 0 11 11H7.5a.5.5 0 0 1 0-1h4a.5.5 0 0 1 .5.5A4.5 4.5 0 0 1 7.5 15Zm11.9-4a11.26 11.26 0 0 1-1.86 3.29 6.67 6.67 0 0 1-1.07-1.48.5.5 0 0 0-.93.38 8 8 0 0 0 1.34 1.87 8.9 8.9 0 0 1-.65.62L14.62 11ZM23 22a1 1 0 0 1-1 1h-7.4l2.77-3.17a.49.49 0 0 0 .09-.48l-.91-2.66a9.36 9.36 0 0 0 1-.89c1 1 1.93 1.91 2.12 2.08a.5.5 0 0 0 .68-.74 43.48 43.48 0 0 1-2.13-2.1 11.49 11.49 0 0 0 2.22-4h1.06a.5.5 0 0 0 0-1H18V9.5a.5.5 0 0 0-1 0v.5h-2.5a.49.49 0 0 0-.21 0l-1.72-5H22a1 1 0 0 1 1 1Z"/>
        </svg>
      </div>
      <h1><span>Cerebras</span> Translator</h1>
      <p class="subtitle">基于大善人的翻译用中转服务</p>
    </div>

    <div class="card">
      <div class="tabs">
        <button class="tab active" onclick="switchTab('keys')">API 密钥</button>
        <button class="tab" onclick="switchTab('models')">模型配置</button>
        <button class="tab" onclick="switchTab('access')">访问控制</button>
      </div>

      <div id="keysTab" class="tab-content active">
        <div class="stats-row">
          <div class="stat-item">
            <div class="stat-value">${stats.totalKeys}</div>
            <div class="stat-label">总密钥</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${stats.activeKeys}</div>
            <div class="stat-label">活跃</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${stats.totalRequests}</div>
            <div class="stat-label">请求数</div>
          </div>
        </div>

        <div class="form-group">
          <label>添加 Cerebras API 密钥</label>
          <input type="text" id="singleKey" class="form-control" placeholder="输入 Cerebras API 密钥">
          <button class="btn" onclick="addSingleKey()" style="margin-top: 8px;">添加</button>
        </div>

        <div class="divider"></div>

        <div class="form-group">
          <label>批量导入</label>
          <textarea id="batchKeys" class="form-control" placeholder="每行一个密钥"></textarea>
          <button class="btn" onclick="addBatchKeys()" style="margin-top: 8px;">导入</button>
        </div>

        <div class="divider"></div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span class="section-title" style="margin: 0;">密钥列表</span>
          <button class="btn btn-outline" onclick="exportAllKeys()">导出全部</button>
        </div>
        <div id="keysContainer"></div>
      </div>

      <div id="modelsTab" class="tab-content">
        <p class="hint" style="margin-top: 0; margin-bottom: 14px;">模型池轮询，分散 TPM 负载</p>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span class="section-title" style="margin: 0;">可用模型目录</span>
          <button class="btn btn-outline" onclick="refreshModelCatalog()" id="refreshModelCatalogBtn">刷新</button>
        </div>
        <p class="hint" id="modelCatalogHint" style="margin-top: 0;">加载中...</p>

        <div id="modelCatalogContainer"></div>
        <button class="btn" onclick="saveModelPoolFromSelection()" style="margin-top: 8px;" id="saveModelPoolBtn">保存模型池</button>
      </div>

      <div id="accessTab" class="tab-content">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <div>
            <span class="section-title" style="margin: 0;">代理访问密钥</span>
            <span id="authBadge" class="auth-badge ${
    stats.proxyAuthEnabled ? "auth-on" : "auth-off"
  }">${stats.proxyAuthEnabled ? "鉴权已开启" : "公开访问"}</span>
          </div>
          <span style="font-size: 11px; color: #64748b;" id="keyCountLabel">${stats.proxyKeyCount}/${MAX_PROXY_KEYS}</span>
        </div>
        <p class="hint" style="margin-top: 0; margin-bottom: 14px;">创建密钥后自动开启鉴权；删除所有密钥则变为公开访问</p>

        <div class="form-group">
          <label>密钥名称（可选）</label>
          <input type="text" id="proxyKeyName" class="form-control" placeholder="例如：移动端应用">
          <button class="btn" onclick="createProxyKey()" style="margin-top: 8px;" id="createProxyKeyBtn">创建密钥</button>
        </div>

        <div class="divider"></div>
        <div class="section-title">已创建的密钥</div>
        <div id="proxyKeysContainer"></div>

        <div class="divider"></div>
        <div class="section-title">高级设置</div>
        <div class="form-group">
          <label>KV 刷盘间隔（ms）</label>
          <input type="number" id="kvFlushIntervalMs" class="form-control" min="1000" step="100" placeholder="例如 15000">
          <button class="btn btn-outline" onclick="saveKvFlushIntervalMs()" style="margin-top: 8px;">保存</button>
          <p class="hint" id="kvFlushIntervalHint">最小 1000ms。用于控制统计/用量写回 KV 的频率。</p>
        </div>
      </div>
    </div>

    <div class="footer">Endpoint: <span>/v1/chat/completions</span></div>
    <div class="notification" id="notification"></div>
  </div>

  <div id="authOverlay">
    <div class="auth-card">
      <div style="text-align: center; margin-bottom: 20px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width: 40px; height: 40px; margin-bottom: 8px; filter: drop-shadow(0 0 12px rgba(6, 182, 212, 0.5));">
          <path fill="#06b6d4" d="M22 4h-9.77L11 .34a.5.5 0 0 0-.5-.34H2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9.65L13 23.68a.5.5 0 0 0 .47.32H22a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM7.5 15a4.5 4.5 0 1 1 2.92-7.92.5.5 0 1 1-.65.76A3.5 3.5 0 1 0 11 11H7.5a.5.5 0 0 1 0-1h4a.5.5 0 0 1 .5.5A4.5 4.5 0 0 1 7.5 15Zm11.9-4a11.26 11.26 0 0 1-1.86 3.29 6.67 6.67 0 0 1-1.07-1.48.5.5 0 0 0-.93.38 8 8 0 0 0 1.34 1.87 8.9 8.9 0 0 1-.65.62L14.62 11ZM23 22a1 1 0 0 1-1 1h-7.4l2.77-3.17a.49.49 0 0 0 .09-.48l-.91-2.66a9.36 9.36 0 0 0 1-.89c1 1 1.93 1.91 2.12 2.08a.5.5 0 0 0 .68-.74 43.48 43.48 0 0 1-2.13-2.1 11.49 11.49 0 0 0 2.22-4h1.06a.5.5 0 0 0 0-1H18V9.5a.5.5 0 0 0-1 0v.5h-2.5a.49.49 0 0 0-.21 0l-1.72-5H22a1 1 0 0 1 1 1Z"/>
        </svg>
        <h2 style="color: #f1f5f9; font-size: 18px;"><span style="background: linear-gradient(135deg, #06b6d4, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Cerebras</span> Translator</h2>
      </div>
      <p id="authTitle" style="color: #94a3b8; font-size: 12px; text-align: center; margin-bottom: 20px;">加载中...</p>
      <div class="form-group">
        <label id="passwordLabel">密码</label>
        <input type="password" id="authPassword" class="form-control" placeholder="输入密码">
      </div>
      <div id="confirmGroup" class="form-group" style="display: none;">
        <label>确认密码</label>
        <input type="password" id="authConfirm" class="form-control" placeholder="再次输入密码">
      </div>
      <button class="btn" id="authBtn" onclick="handleAuth()" style="width: 100%; padding: 10px; font-size: 13px;">提交</button>
      <p id="authError" style="color: #f87171; font-size: 11px; text-align: center; margin-top: 10px; display: none;"></p>
    </div>
  </div>

  <script>
    let adminToken = localStorage.getItem('adminToken') || '';
    let authMode = 'login';
    const MAX_PROXY_KEYS = ${MAX_PROXY_KEYS};

    let currentModelPool = [];
    let modelCatalogState = null;

    // 主题管理
    function loadTheme() {
      const saved = localStorage.getItem('theme') || 'light';
      document.body.className = saved;
      updateThemeIcon();
    }

    function toggleTheme() {
      const current = document.body.classList.contains('dark') ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.body.className = next;
      localStorage.setItem('theme', next);
      updateThemeIcon();
    }

    function updateThemeIcon() {
      const isDark = document.body.classList.contains('dark');
      document.getElementById('sunIcon').style.display = isDark ? 'none' : 'block';
      document.getElementById('moonIcon').style.display = isDark ? 'block' : 'none';
    }

    loadTheme();

    function getAuthHeaders() { return { 'X-Admin-Token': adminToken }; }

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tabs = ['keys', 'models', 'access'];
      const idx = tabs.indexOf(tab);
      if (idx >= 0) {
        document.querySelectorAll('.tab')[idx].classList.add('active');
        document.getElementById(tab + 'Tab').classList.add('active');
      }
    }

    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showAuthError(getApiErrorMessage(res, data));
          return;
        }
        if (!data.hasPassword) {
          authMode = 'setup';
          document.getElementById('authTitle').textContent = '首次使用，请设置管理密码';
          document.getElementById('passwordLabel').textContent = '新密码（至少 4 位）';
          document.getElementById('confirmGroup').style.display = 'block';
          document.getElementById('authBtn').textContent = '设置密码';
          document.getElementById('authOverlay').style.display = 'flex';
        } else if (!data.isLoggedIn) {
          authMode = 'login';
          document.getElementById('authTitle').textContent = '请登录以继续';
          document.getElementById('passwordLabel').textContent = '密码';
          document.getElementById('confirmGroup').style.display = 'none';
          document.getElementById('authBtn').textContent = '登录';
          document.getElementById('authOverlay').style.display = 'flex';
        } else {
          document.getElementById('authOverlay').style.display = 'none';
          loadProxyKeys();
          loadKeys();
          loadModelCatalog();
          loadModels();
          loadConfig();
        }
      } catch (e) { showAuthError('检查登录状态失败'); }
    }

    function showAuthError(msg) {
      const el = document.getElementById('authError');
      el.textContent = msg;
      el.style.display = 'block';
    }

    async function handleAuth() {
      const password = document.getElementById('authPassword').value;
      document.getElementById('authError').style.display = 'none';
      if (authMode === 'setup') {
        const confirm = document.getElementById('authConfirm').value;
        if (password.length < 4) { showAuthError('密码至少 4 位'); return; }
        if (password !== confirm) { showAuthError('两次密码不一致'); return; }
        try {
          const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAuthError(getApiErrorMessage(res, data) || '设置失败');
            return;
          }
          if (data.success && data.token) { adminToken = data.token; localStorage.setItem('adminToken', adminToken); checkAuth(); }
          else showAuthError('设置失败');
        } catch (e) { showAuthError('错误: ' + formatClientError(e)); }
      } else {
        try {
          const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAuthError(getApiErrorMessage(res, data) || '登录失败');
            return;
          }
          if (data.success && data.token) { adminToken = data.token; localStorage.setItem('adminToken', adminToken); checkAuth(); }
          else showAuthError('登录失败');
        } catch (e) { showAuthError('错误: ' + formatClientError(e)); }
      }
    }

    document.getElementById('authPassword').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') { if (authMode === 'setup') document.getElementById('authConfirm').focus(); else handleAuth(); }
    });
    document.getElementById('authConfirm')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAuth(); });

    let notificationTimer = null;
    function showNotification(message, type = 'success') {
      const notif = document.getElementById('notification');
      if (!notif) { alert(message); return; }
      if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
      }
      notif.textContent = message;
      notif.className = 'notification show ' + type;
      notif.style.display = 'block';
      notif.style.zIndex = '10000';
      notificationTimer = setTimeout(() => {
        notif.classList.remove('show');
        notif.style.display = 'none';
        notificationTimer = null;
      }, 3000);
    }

    function formatClientError(error) {
      if (!error) return '未知错误';
      if (error.name === 'AbortError') return '请求超时，请稍后重试';
      const msg = error.message || String(error);
      const lower = msg.toLowerCase();
      if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('err_connection_refused')) {
        return '无法连接到本地服务（' + location.origin + '），请确认 Deno 服务在运行且端口可访问';
      }
      return msg;
    }

    async function fetchJsonWithTimeout(url, options, timeoutMs = 15000) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const text = await res.text();
        let data = {};
        if (text) {
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
        }
        return { res, data };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function getApiErrorMessage(res, data) {
      if (data && typeof data.detail === 'string' && data.detail.trim()) return data.detail;
      if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
      if (data && typeof data.title === 'string' && data.title.trim()) return data.title;
      if (data && typeof data.message === 'string' && data.message.trim()) return data.message;
      return 'HTTP ' + res.status;
    }

    function handleUnauthorized(res) {
      if (res.status !== 401) return false;
      adminToken = '';
      localStorage.removeItem('adminToken');
      checkAuth();
      return true;
    }

    function setButtonLoading(btn, loading, text) {
      if (!btn) return;

      if (loading) {
        if (!('oldText' in btn.dataset)) {
          btn.dataset.oldText = btn.textContent || '';
        }

        const w = btn.getBoundingClientRect().width;
        if (Number.isFinite(w) && w > 0) {
          btn.dataset.oldWidth = String(w);
          btn.style.width = w + 'px';
        }

        btn.classList.add('is-loading');
        btn.textContent = text || '处理中...';
        btn.disabled = true;
        return;
      }

      if ('oldText' in btn.dataset) {
        btn.textContent = btn.dataset.oldText || '';
      }

      delete btn.dataset.oldText;
      delete btn.dataset.oldWidth;
      btn.style.width = '';
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }

    // 配置管理
    async function loadConfig() {
      try {
        const res = await fetch('/api/config', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载配置失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const input = document.getElementById('kvFlushIntervalMs');
        if (input) {
          input.value = String(data.kvFlushIntervalMs ?? '');
          if (data.kvFlushIntervalMinMs) input.min = String(data.kvFlushIntervalMinMs);
        }

        const hint = document.getElementById('kvFlushIntervalHint');
        if (hint) {
          const effective = data.effectiveKvFlushIntervalMs ?? data.kvFlushIntervalMs;
          hint.textContent = '当前生效：' + String(effective ?? '') + 'ms';
        }
      } catch (e) {
        showNotification('加载配置失败: ' + formatClientError(e), 'error');
      }
    }

    async function saveKvFlushIntervalMs() {
      const el = document.getElementById('kvFlushIntervalMs');
      const raw = el ? el.value : '';
      const ms = Number(raw);
      const min = Number(el?.min || '1000');

      if (!Number.isFinite(ms)) {
        showNotification('请输入合法数字', 'error');
        return;
      }
      if (ms < min) {
        showNotification('最小 ' + String(min) + 'ms', 'error');
        return;
      }

      try {
        const res = await fetch('/api/config', {
          method: 'PATCH',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ kvFlushIntervalMs: ms }),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '保存失败', 'error');
          return;
        }
        showNotification('已保存');
        loadConfig();
      } catch (e) {
        showNotification('保存失败: ' + formatClientError(e), 'error');
      }
    }

    // 代理密钥管理
    async function loadProxyKeys() {
      try {
        const res = await fetch('/api/proxy-keys', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const container = document.getElementById('proxyKeysContainer');
        const badge = document.getElementById('authBadge');
        const countLabel = document.getElementById('keyCountLabel');
        const createBtn = document.getElementById('createProxyKeyBtn');

        countLabel.textContent = (data.keys?.length || 0) + '/' + MAX_PROXY_KEYS;
        createBtn.disabled = (data.keys?.length || 0) >= MAX_PROXY_KEYS;

        if (data.authEnabled) {
          badge.className = 'auth-badge auth-on';
          badge.textContent = '鉴权已开启';
        } else {
          badge.className = 'auth-badge auth-off';
          badge.textContent = '公开访问';
        }

        if (data.keys?.length > 0) {
          container.textContent = '';

          for (const k of data.keys) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const keySpan = document.createElement('span');
            keySpan.className = 'key-text';
            keySpan.id = 'pk-' + k.id;
            keySpan.textContent = String(k.key ?? '');

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn-icon';
            toggleBtn.title = '查看完整密钥';
            toggleBtn.addEventListener('click', () => toggleProxyKeyVisibility(k.id));

            const svgNs = 'http://www.w3.org/2000/svg';

            const eyeIcon = document.createElementNS(svgNs, 'svg');
            eyeIcon.id = 'pk-eye-' + k.id;
            eyeIcon.setAttribute('xmlns', svgNs);
            eyeIcon.setAttribute('width', '12');
            eyeIcon.setAttribute('height', '12');
            eyeIcon.setAttribute('viewBox', '0 0 24 24');
            eyeIcon.setAttribute('fill', 'none');
            eyeIcon.setAttribute('stroke', 'currentColor');
            eyeIcon.setAttribute('stroke-width', '2');

            const eyePath = document.createElementNS(svgNs, 'path');
            eyePath.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');

            const eyeCircle = document.createElementNS(svgNs, 'circle');
            eyeCircle.setAttribute('cx', '12');
            eyeCircle.setAttribute('cy', '12');
            eyeCircle.setAttribute('r', '3');

            eyeIcon.appendChild(eyePath);
            eyeIcon.appendChild(eyeCircle);

            const eyeOffIcon = document.createElementNS(svgNs, 'svg');
            eyeOffIcon.id = 'pk-eye-off-' + k.id;
            eyeOffIcon.setAttribute('xmlns', svgNs);
            eyeOffIcon.setAttribute('width', '12');
            eyeOffIcon.setAttribute('height', '12');
            eyeOffIcon.setAttribute('viewBox', '0 0 24 24');
            eyeOffIcon.setAttribute('fill', 'none');
            eyeOffIcon.setAttribute('stroke', 'currentColor');
            eyeOffIcon.setAttribute('stroke-width', '2');
            eyeOffIcon.style.display = 'none';

            const eyeOffPath = document.createElementNS(svgNs, 'path');
            eyeOffPath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24');

            const eyeOffLine = document.createElementNS(svgNs, 'line');
            eyeOffLine.setAttribute('x1', '1');
            eyeOffLine.setAttribute('y1', '1');
            eyeOffLine.setAttribute('x2', '23');
            eyeOffLine.setAttribute('y2', '23');

            eyeOffIcon.appendChild(eyeOffPath);
            eyeOffIcon.appendChild(eyeOffLine);

            toggleBtn.appendChild(eyeIcon);
            toggleBtn.appendChild(eyeOffIcon);

            primary.appendChild(keySpan);
            primary.appendChild(toggleBtn);

            const secondary = document.createElement('div');
            secondary.className = 'item-secondary';
            secondary.textContent = String(k.name ?? '') + ' · 已使用 ' + String(k.useCount ?? 0) + ' 次';

            info.appendChild(primary);
            info.appendChild(secondary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-outline';
            copyBtn.textContent = '复制';
            copyBtn.addEventListener('click', () => copyProxyKey(k.id));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', () => deleteProxyKey(k.id));

            actions.appendChild(copyBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '暂无代理密钥，API 当前为公开访问';
          container.appendChild(empty);
        }
      } catch (e) { showNotification('加载失败: ' + formatClientError(e), 'error'); }
    }

    async function createProxyKey() {
      const name = document.getElementById('proxyKeyName').value.trim();
      try {
        const res = await fetch('/api/proxy-keys', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '创建失败', 'error');
          return;
        }

        showNotification('密钥已创建，请立即复制保存');
        document.getElementById('proxyKeyName').value = '';
        loadProxyKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function deleteProxyKey(id) {
      if (!confirm('删除此密钥？使用此密钥的客户端将无法访问')) return;
      try {
        const res = await fetch('/api/proxy-keys/' + id, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '删除失败', 'error');
          return;
        }
        showNotification('密钥已删除');
        loadProxyKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    const proxyKeyFullValues = {};
    async function toggleProxyKeyVisibility(id) {
      const keySpan = document.getElementById('pk-' + id);
      const eyeIcon = document.getElementById('pk-eye-' + id);
      const eyeOffIcon = document.getElementById('pk-eye-off-' + id);
      if (eyeIcon.style.display !== 'none') {
        if (!proxyKeyFullValues[id]) {
          try {
            const res = await fetch('/api/proxy-keys/' + id + '/export', { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (handleUnauthorized(res)) return;
            if (res.ok && data.key) proxyKeyFullValues[id] = data.key;
          } catch (e) { return; }
        }
        if (proxyKeyFullValues[id]) {
          keySpan.textContent = proxyKeyFullValues[id];
          eyeIcon.style.display = 'none';
          eyeOffIcon.style.display = 'inline';
        }
      } else { loadProxyKeys(); }
    }

    async function copyProxyKey(id) {
      try {
        const res = await fetch('/api/proxy-keys/' + id + '/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '复制失败', 'error');
          return;
        }
        if (data.key) { await navigator.clipboard.writeText(data.key); showNotification('密钥已复制'); }
        else showNotification('复制失败', 'error');
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    // API 密钥管理
    async function addSingleKey() {
      const key = document.getElementById('singleKey').value.trim();
      if (!key) { showNotification('请输入密钥', 'error'); return; }
      try {
        const res = await fetch('/api/keys', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '添加失败', 'error');
          return;
        }
        showNotification('密钥已添加');
        document.getElementById('singleKey').value = '';
        loadKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function addBatchKeys() {
      const input = document.getElementById('batchKeys').value.trim();
      if (!input) { showNotification('请输入密钥', 'error'); return; }
      try {
        const res = await fetch('/api/keys/batch', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '导入失败', 'error');
          return;
        }
        if (data.summary) { showNotification(\`导入完成：\${data.summary.success} 成功，\${data.summary.failed} 失败\`); document.getElementById('batchKeys').value = ''; loadKeys(); }
        else showNotification('导入失败', 'error');
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function loadKeys() {
      try {
        const res = await fetch('/api/keys', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        const container = document.getElementById('keysContainer');
        if (data.keys?.length > 0) {
          container.textContent = '';

          for (const k of data.keys) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const info = document.createElement('div');
            info.className = 'item-info';

            const primary = document.createElement('div');
            primary.className = 'item-primary';

            const keySpan = document.createElement('span');
            keySpan.className = 'key-text';
            keySpan.id = 'key-' + k.id;
            keySpan.textContent = String(k.key ?? '');

            const keyActions = document.createElement('span');
            keyActions.className = 'key-actions';

            const svgNs = 'http://www.w3.org/2000/svg';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn-icon';
            toggleBtn.title = '查看完整密钥';
            toggleBtn.addEventListener('click', () => toggleKeyVisibility(k.id));

            const eyeIcon = document.createElementNS(svgNs, 'svg');
            eyeIcon.id = 'eye-' + k.id;
            eyeIcon.setAttribute('xmlns', svgNs);
            eyeIcon.setAttribute('width', '14');
            eyeIcon.setAttribute('height', '14');
            eyeIcon.setAttribute('viewBox', '0 0 24 24');
            eyeIcon.setAttribute('fill', 'none');
            eyeIcon.setAttribute('stroke', 'currentColor');
            eyeIcon.setAttribute('stroke-width', '2');

            const eyePath = document.createElementNS(svgNs, 'path');
            eyePath.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');

            const eyeCircle = document.createElementNS(svgNs, 'circle');
            eyeCircle.setAttribute('cx', '12');
            eyeCircle.setAttribute('cy', '12');
            eyeCircle.setAttribute('r', '3');

            eyeIcon.appendChild(eyePath);
            eyeIcon.appendChild(eyeCircle);

            const eyeOffIcon = document.createElementNS(svgNs, 'svg');
            eyeOffIcon.id = 'eye-off-' + k.id;
            eyeOffIcon.setAttribute('xmlns', svgNs);
            eyeOffIcon.setAttribute('width', '14');
            eyeOffIcon.setAttribute('height', '14');
            eyeOffIcon.setAttribute('viewBox', '0 0 24 24');
            eyeOffIcon.setAttribute('fill', 'none');
            eyeOffIcon.setAttribute('stroke', 'currentColor');
            eyeOffIcon.setAttribute('stroke-width', '2');
            eyeOffIcon.style.display = 'none';

            const eyeOffPath = document.createElementNS(svgNs, 'path');
            eyeOffPath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24');

            const eyeOffLine = document.createElementNS(svgNs, 'line');
            eyeOffLine.setAttribute('x1', '1');
            eyeOffLine.setAttribute('y1', '1');
            eyeOffLine.setAttribute('x2', '23');
            eyeOffLine.setAttribute('y2', '23');

            eyeOffIcon.appendChild(eyeOffPath);
            eyeOffIcon.appendChild(eyeOffLine);

            toggleBtn.appendChild(eyeIcon);
            toggleBtn.appendChild(eyeOffIcon);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-icon';
            copyBtn.title = '复制密钥';
            copyBtn.addEventListener('click', () => copyKey(k.id));

            const copySvg = document.createElementNS(svgNs, 'svg');
            copySvg.setAttribute('xmlns', svgNs);
            copySvg.setAttribute('width', '14');
            copySvg.setAttribute('height', '14');
            copySvg.setAttribute('viewBox', '0 0 24 24');
            copySvg.setAttribute('fill', 'none');
            copySvg.setAttribute('stroke', 'currentColor');
            copySvg.setAttribute('stroke-width', '2');

            const copyRect = document.createElementNS(svgNs, 'rect');
            copyRect.setAttribute('x', '9');
            copyRect.setAttribute('y', '9');
            copyRect.setAttribute('width', '13');
            copyRect.setAttribute('height', '13');
            copyRect.setAttribute('rx', '2');
            copyRect.setAttribute('ry', '2');

            const copyPath = document.createElementNS(svgNs, 'path');
            copyPath.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

            copySvg.appendChild(copyRect);
            copySvg.appendChild(copyPath);
            copyBtn.appendChild(copySvg);

            keyActions.appendChild(toggleBtn);
            keyActions.appendChild(copyBtn);

            primary.appendChild(keySpan);
            primary.appendChild(keyActions);

            const secondary = document.createElement('div');
            secondary.className = 'item-secondary';

            const statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + String(k.status ?? '');
            statusBadge.textContent = String(k.status ?? '');

            secondary.appendChild(statusBadge);
            secondary.appendChild(document.createTextNode(' · 已使用 ' + String(k.useCount ?? 0) + ' 次'));

            info.appendChild(primary);
            info.appendChild(secondary);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const testBtn = document.createElement('button');
            testBtn.className = 'btn btn-success';
            testBtn.textContent = '测试';
            testBtn.addEventListener('click', () => testKey(k.id, testBtn));

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', () => deleteKey(k.id));

            actions.appendChild(testBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);

            container.appendChild(item);
          }
        } else {
          container.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = '暂无 API 密钥';
          container.appendChild(empty);
        }
      } catch (e) { showNotification('加载失败: ' + formatClientError(e), 'error'); }
    }

    async function copyKey(id) {
      try {
        const res = await fetch('/api/keys/' + id + '/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '复制失败', 'error');
          return;
        }
        if (data.key) {
          await navigator.clipboard.writeText(data.key);
          showNotification('密钥已复制');
        } else {
          showNotification('复制失败', 'error');
        }
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    const keyFullValues = {};
    async function toggleKeyVisibility(id) {
      const keySpan = document.getElementById('key-' + id);
      const eyeIcon = document.getElementById('eye-' + id);
      const eyeOffIcon = document.getElementById('eye-off-' + id);
      if (eyeIcon.style.display !== 'none') {
        if (!keyFullValues[id]) {
          try {
            const res = await fetch('/api/keys/' + id + '/export', { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            if (handleUnauthorized(res)) return;
            if (res.ok && data.key) keyFullValues[id] = data.key;
          } catch (e) { return; }
        }
        if (keyFullValues[id]) { keySpan.textContent = keyFullValues[id]; eyeIcon.style.display = 'none'; eyeOffIcon.style.display = 'inline'; }
      } else { loadKeys(); }
    }

    async function deleteKey(id) {
      if (!confirm('删除此密钥？')) return;
      try {
        const res = await fetch('/api/keys/' + id, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '删除失败', 'error');
          return;
        }
        showNotification('密钥已删除');
        loadKeys();
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    async function testKey(id, btn) {
      setButtonLoading(btn, true, '在测');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/keys/' + id + '/test', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('密钥测试失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        if (data.success) {
          showNotification('密钥有效', 'success');
        } else {
          const detail = data.error || data.status || (res.ok ? '' : ('HTTP ' + res.status));
          if (data.status === 'invalid') showNotification('密钥失效: ' + detail, 'error');
          else showNotification('密钥不可用: ' + detail, 'error');
        }
        loadKeys();
      } catch (e) {
        showNotification('密钥测试失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function exportAllKeys() {
      try {
        const res = await fetch('/api/keys/export', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '导出失败', 'error');
          return;
        }
        if (data.keys?.length > 0) { await navigator.clipboard.writeText(data.keys.join('\\n')); showNotification(\`\${data.keys.length} 个密钥已复制\`); }
        else showNotification('没有密钥可导出', 'error');
      } catch (e) { showNotification('错误: ' + formatClientError(e), 'error'); }
    }

    // 模型管理
    function formatTimestamp(ms) {
      try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
    }

    function renderModelCatalog() {
      const container = document.getElementById('modelCatalogContainer');
      const hint = document.getElementById('modelCatalogHint');
      if (!container || !hint) return;

      const pool = Array.isArray(currentModelPool) ? currentModelPool.map(m => String(m)) : [];
      const poolSet = new Set(pool);

      const catalogModels = (modelCatalogState && Array.isArray(modelCatalogState.models))
        ? modelCatalogState.models.map(m => String(m))
        : [];
      const catalogSet = new Set(catalogModels);

      container.textContent = '';

      if (!modelCatalogState) {
        hint.textContent = '未加载模型目录';
      } else {
        const fetchedAt = modelCatalogState.fetchedAt ? formatTimestamp(modelCatalogState.fetchedAt) : '';
        const stale = modelCatalogState.stale ? '；目录可能过时' : '';
        const lastError = modelCatalogState.lastError ? ('；上次错误：' + modelCatalogState.lastError) : '';
        hint.textContent = '目录模型数：' + String(catalogModels.length) + (fetchedAt ? ('；更新时间：' + fetchedAt) : '') + stale + lastError;
      }

      function addCheckboxRow(model, badgeText) {
        const name = String(model || '').trim();
        if (!name) return;

        const item = document.createElement('div');
        item.className = 'list-item';

        const info = document.createElement('div');
        info.className = 'item-info';

        const primary = document.createElement('div');
        primary.className = 'item-primary';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'model-pool-checkbox';
        checkbox.dataset.model = name;
        checkbox.checked = poolSet.has(name);
        checkbox.style.marginRight = '8px';

        const modelSpan = document.createElement('span');
        modelSpan.className = 'key-text';
        modelSpan.textContent = name;

        primary.appendChild(checkbox);
        primary.appendChild(modelSpan);

        if (badgeText) {
          const badge = document.createElement('span');
          badge.className = 'status-badge status-inactive';
          badge.textContent = badgeText;
          primary.appendChild(badge);
        }

        info.appendChild(primary);
        item.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const encodedName = encodeURIComponent(name);

        const testBtn = document.createElement('button');
        testBtn.className = 'btn btn-success';
        testBtn.textContent = '测试';
        testBtn.addEventListener('click', () => testModel(encodedName, testBtn));

        actions.appendChild(testBtn);
        item.appendChild(actions);

        container.appendChild(item);
      }

      const extras = pool.filter((m) => !catalogSet.has(m));
      if (extras.length > 0) {
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = '不在目录';
        container.appendChild(title);
        for (const m of extras) addCheckboxRow(m, '已选');

        const divider = document.createElement('div');
        divider.className = 'divider';
        container.appendChild(divider);
      }

      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = '目录模型';
      container.appendChild(title);

      if (catalogModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '目录为空（可能是网络问题或上游变更）';
        container.appendChild(empty);
        return;
      }

      for (const m of catalogModels) {
        addCheckboxRow(m, '');
      }
    }

    async function loadModelCatalog() {
      try {
        const res = await fetch('/api/models/catalog', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载模型目录失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        modelCatalogState = data;
        renderModelCatalog();
      } catch (e) {
        showNotification('加载模型目录失败: ' + formatClientError(e), 'error');
      }
    }

    async function refreshModelCatalog() {
      const btn = document.getElementById('refreshModelCatalogBtn');
      setButtonLoading(btn, true, '刷新中...');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/models/catalog/refresh', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('刷新失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        modelCatalogState = data;
        showNotification('目录已刷新');
        renderModelCatalog();
      } catch (e) {
        showNotification('刷新失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function saveModelPoolFromSelection() {
      const btn = document.getElementById('saveModelPoolBtn');
      setButtonLoading(btn, true, '保存中...');

      try {
        const nodes = document.querySelectorAll('.model-pool-checkbox');
        const models = [];
        const seen = new Set();

        for (const el of nodes) {
          if (!el || el.type !== 'checkbox') continue;
          if (!el.checked) continue;
          const m = String(el.dataset.model || '').trim();
          if (!m || seen.has(m)) continue;
          seen.add(m);
          models.push(m);
        }

        if (models.length === 0) {
          showNotification('模型池不能为空', 'error');
          return;
        }

        const res = await fetch('/api/models', {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ models }),
        });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification(getApiErrorMessage(res, data) || '保存失败', 'error');
          return;
        }

        showNotification('模型池已保存');
        loadModels();
      } catch (e) {
        showNotification('保存失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    async function loadModels() {
      try {
        const res = await fetch('/api/models', { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('加载失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }

        currentModelPool = Array.isArray(data.models) ? data.models.map(m => String(m)) : [];
        renderModelCatalog();
      } catch (e) {
        showNotification('加载失败: ' + formatClientError(e), 'error');
      }
    }

    async function testModel(name, btn) {
      setButtonLoading(btn, true, '在测');
      try {
        const { res, data } = await fetchJsonWithTimeout('/api/models/' + name + '/test', { method: 'POST', headers: getAuthHeaders() }, 15000);
        if (handleUnauthorized(res)) return;
        if (!res.ok) {
          showNotification('模型测试失败: ' + getApiErrorMessage(res, data), 'error');
          return;
        }
        const ok = Boolean(data.success);
        const detail = data.error || data.status || (res.ok ? '' : ('HTTP ' + res.status));
        showNotification(ok ? '模型可用' : ('模型不可用: ' + detail), ok ? 'success' : 'error');
      } catch (e) {
        showNotification('模型测试失败: ' + formatClientError(e), 'error');
      } finally {
        setButtonLoading(btn, false);
      }
    }

    checkAuth();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/html" },
  });
}
