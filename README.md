# pi Browser Companion

**pi Browser Companion** 是一个 Chrome 扩展，将 [pi coding agent](https://pi.dev) 的能力带入浏览器。通过它，你可以在浏览网页时与 pi 智能助手实时协作：

- **📄 总结文章** — 自动提取网页正文，生成 AI 摘要
- **💬 对话讨论** — 围绕页面内容与 pi 深入交流
- **🎨 修改页面** — 让 pi 帮你调整网页的样式、布局和视觉表现

## 系统架构

```
┌─ Browser (Chrome) ─────────────────────────────┐
│  ┌──────────┐  ┌────────────┐  ┌────────────┐  │
│  │  Popup   │  │ Side Panel │  │ Content    │  │
│  │ (快速操作) │  │ (聊天界面)  │  │ Script     │  │
│  └────┬─────┘  └─────┬──────┘  └─────┬──────┘  │
│       └───────┬──────┘               │         │
│               │ chrome.runtime       │         │
│        ┌──────▼──────┐               │         │
│        │  Background  │◄─────────────┘         │
│        │  ServiceWorker│                        │
│        └──────┬───────┘                        │
└───────────────┼────────────────────────────────┘
                │ WebSocket (JSONL)
┌───────────────▼────────────────────────────────┐
│  Local Bridge Service (Node.js)                 │
│                                                 │
│  ┌────────────┐  ┌──────────────────────────┐  │
│  │ WS Server  │◄─┤  pi SDK                   │  │
│  │ (ws@8)     │  │  ─ AgentSession           │  │
│  └────────────┘  │  ─ Custom Tools           │  │
│                   │  ─ ResourceLoader         │  │
│                   └──────────────────────────┘  │
│                              │                  │
│                              ▼                  │
│                    ┌──────────────────┐         │
│                    │  LLM (Anthropic/ │         │
│                    │  OpenAI/etc.)    │         │
│                    └──────────────────┘         │
└────────────────────────────────────────────────┘
```

## 快速开始

### 前置条件

| 依赖 | 说明 |
|------|------|
| Node.js 22+ | 运行 Bridge 服务 |
| npm 包管理器 | 安装依赖 |
| LLM API Key | `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 等 |

> pi 会自动发现你已在 `~/.pi/agent/auth.json` 中配置的认证信息。
> 如果你还没有配置，也可以通过环境变量设置：`export ANTHROPIC_API_KEY=sk-ant-...`

---

### 第一步：构建 Bridge 服务

```bash
cd bridge

# 安装依赖（约 200MB，包含 pi SDK 及其依赖）
npm install

# 开发模式运行（tsx watch，自动重启）
npm run dev
```

Bridge 启动后默认监听 `ws://127.0.0.1:18731`，控制台输出：
```
╔══════════════════════════════════════════════╗
║   pi Chrome Extension Bridge Service         ║
╠══════════════════════════════════════════════╣
║  Port:       18731                           ║
║  Host:       127.0.0.1                       ║
║  Auth:       None                            ║
║  Agent Dir:  ~/.pi/agent                     ║
╚══════════════════════════════════════════════╝
```

**如果启动失败：**
- 确保已配置 LLM API Key（`echo $ANTHROPIC_API_KEY`）
- 或先用 `pi` 命令在终端测试一下 pi 是否正常工作

**生产模式部署：**
```bash
npm run build          # tsc 编译到 dist/
npm start              # node dist/index.js
```

---

### 第二步：构建扩展

```bash
cd extension

# 安装依赖
npm install

# 开发模式（WXT + Vite，HMR 热更新）
npm run dev
```

WXT 会在 `.output/chrome-mv3/` 目录生成开发构建。

**加载到 Chrome：**
1. 打开 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展**
4. 选择 `extension/.output/chrome-mv3/` 目录
5. 确认图标已出现在工具栏

**生产构建：**
```bash
npm run build     # 构建
npm run zip       # 打包 .zip
```

---

### 第三步：运行

确保 Bridge 在运行中（第一步），然后：

| 快捷键 | 功能 |
|--------|------|
| `Alt+P` | 打开弹出面板（快速操作） |
| `Alt+Shift+P` | 打开侧边面板（完整聊天界面） |
| — | 点击 ⚙️ 配置 Bridge 地址 |

> **注意：** 首次打开侧边面板时，点击底部横幅 "Bridge disconnected — click to reconnect" 可手动连接。
> 打开连接后在 Options 页面（右键图标→选项）配置 Bridge URL（默认 `ws://127.0.0.1:18731`）。

---

### 验证安装

成功启动后应该看到：

1. **Bridge 控制台** 显示 "pi agent initialized"
2. **Chrome 扩展图标** 变为彩色 π 图标
3. **侧边面板** 底部显示 "🟢 Bridge connected"
4. 点击 **Summarize** 按钮，pi 会分析当前页面并生成摘要

## 项目结构

```
pi-chrome-extension/
├── ARCHITECTURE.md             # 完整架构文档
├── package.json, README.md
├──
├── bridge/                     # ★ 本地桥接服务
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── config.ts           # 配置管理 + 环境变量
│       ├── types.ts            # WebSocket 协议类型
│       ├── context.ts          # 页面上下文格式化
│       ├── pi-agent.ts         # ★ pi SDK 集成核心
│       ├── ws-server.ts        # ★ WebSocket 服务器
│       └── index.ts            # 入口
│
└── extension/                  # ★ Chrome 扩展
    ├── package.json
    ├── wxt.config.ts           # WXT 构建配置
    ├── entrypoints/
    │   ├── background/index.ts # Service Worker（消息路由 + WS）
    │   ├── content-script/     # 页面提取 + 修改执行器
    │   ├── popup/index.html    # 弹出面板
    │   ├── sidepanel/index.html # 聊天界面
    │   └── options/index.html  # 设置页
    └── src/shared/types.ts
```

## 自定义工具

pi 通过以下自定义工具与浏览器交互：

### 页面读取
| 工具 | 功能 |
|------|------|
| `read_page_content` | 读取页面完整文章内容 |
| `read_selection` | 读取用户选中的文字 |
| `get_page_headings` | 获取页面标题结构 |
| `get_page_metadata` | 获取页面元数据 |

### 页面修改
| 工具 | 功能 |
|------|------|
| `modify_page_css` | 注入自定义 CSS |
| `modify_page_style` | 修改指定元素样式 |
| `toggle_dark_mode` | 切换深色模式 |
| `highlight_elements` | 高亮指定元素 |
| `remove_elements` | 隐藏元素（可恢复） |
| `revert_page_modifications` | 撤销所有修改 |
| `inject_script` | 执行 JavaScript |

## 环境变量 (Bridge)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_CHROME_PORT` | WebSocket 端口 | `18731` |
| `PI_CHROME_HOST` | 监听地址 | `127.0.0.1` |
| `PI_CHROME_TOKEN` | 认证令牌 | 无（不认证） |
| `PI_CHROME_PROVIDER` | 默认 LLM 提供商 | 由 pi 自动选择 |
| `PI_CHROME_MODEL` | 默认模型 | 由 pi 自动选择 |
| `PI_CHROME_MAX_CONTEXT` | 页面内容最大长度 | `50000` |

## 开发路线图

- [x] **Phase 1**: 基础架构 — Bridge 服务 + WebSocket 通信 + 内容提取
- [x] **Phase 2**: 核心功能 — 对话、摘要、页面修改
- [ ] **Phase 3**: 体验优化 — 撤销历史、会话管理、多标签支持
- [ ] **Phase 4**: 进阶功能 — 截图、多模型切换、i18n

## 技术栈

- **Extension**: TypeScript, WXT, React, Tailwind
- **Bridge**: Node.js, pi SDK, ws (WebSocket)
- **AI**: pi coding agent (Anthropic/OpenAI 等)

## License

MIT
