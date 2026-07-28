# pi Browser Companion

[English](./README.md) | **中文**

**pi Browser Companion** 是一个 Chrome 扩展，将 [pi coding agent](https://pi.dev) 的能力带入浏览器。在浏览网页时与 pi 实时协作：

- **📄 总结与对话** — 提取网页正文生成摘要，围绕内容深入交流
- **🎨 修改页面** — 让 pi 调整样式、布局、视觉表现（CSS 持久化，刷新自动恢复）
- **📑 PDF 支持** — 自动提取 PDF 文本，扫描版 PDF 渲染页面图片给视觉模型
- **📁 本地文件** — 受控的 `safe_read` / `list_dir`，硬过滤敏感路径（`~/.ssh`、`auth.json`、`.env` 等）
- **➗ 数学公式** — KaTeX 渲染 `$...$` / `$$...$$`
- **🌐 语言偏好** — 设置回复语言（`auto` 跟随页面，或指定 `中文`/`English`/...）

## 系统架构

```
┌─ Browser (Chrome) ─────────────────────────────┐
│  ┌───────────────┐  ┌────────────┐             │
│  │  Side Panel   │  │ Content    │             │
│  │  (聊天界面)    │  │ Script     │             │
│  └───────┬───────┘  └─────┬──────┘             │
│          │ chrome.runtime  │                    │
│   ┌──────▼──────────────▼──────┐               │
│   │  Background Service Worker │               │
│   │  (消息路由 + WS 客户端)     │               │
│   └────────────┬──────────────┘               │
└────────────────┼───────────────────────────────┘
                 │ WebSocket (JSONL)
┌────────────────▼───────────────────────────────┐
│  Local Bridge Service (Node.js)                │
│  ┌────────────┐  ┌──────────────────────────┐  │
│  │ WS Server  │◄─┤  pi SDK                   │  │
│  │ (ws@8)     │  │  ─ AgentSession           │  │
│  └────────────┘  │  ─ Custom Tools (18)      │  │
│                   │  ─ clawpdf (PDF)          │  │
│                   └─────────────┬────────────┘  │
│                                 ▼               │
│                    ┌──────────────────┐         │
│                    │  LLM             │         │
│                    │  (zai/openai/    │         │
│                    │   anthropic/...) │         │
│                    └──────────────────┘         │
└────────────────────────────────────────────────┘
```

三层架构：**扩展 ↔ Bridge（本地 Node 服务，WebSocket）↔ pi SDK / LLM**。所有 LLM 处理在本地 Bridge 运行，扩展只负责浏览器交互。

## 快速开始

### 前置条件

| 依赖 | 说明 |
|------|------|
| Node.js 22+ | 运行 Bridge |
| pi 认证 | `~/.pi/agent/auth.json`（用 `pi auth login` 配置，支持 zai / opencode / github-copilot / anthropic / openai 等） |

> Bridge 通过 `AuthStorage.create()` 自动发现 `~/.pi/agent/` 下的认证。无需在扩展里填 API key。

### 第一步：构建并运行 Bridge

```bash
cd bridge
npm install        # 含 pi SDK + clawpdf
npm run dev        # tsx watch，改动自动重载
```

默认监听 `ws://127.0.0.1:18731`。启动成功会显示 `pi agent initialized (model: ...)`。

### 第二步：构建并加载扩展

```bash
cd extension
npm install
npm run build      # 产物在 output/chrome-mv3/
```

> 输出到不带点的 `output/`（非 WXT 默认的 `.output/`），这样 Chrome 的"加载已解压扩展"目录选择器能直接看到。

**加载到 Chrome：**
1. 打开 `chrome://extensions` → 开启 **开发者模式**
2. **加载已解压的扩展** → 选 `extension/output/chrome-mv3/`
3. 工具栏出现 π 图标

### 第三步：使用

| 操作 | 功能 |
|------|------|
| 点击工具栏 π 图标 / `Alt+Shift+P` | 打开侧边面板 |
| 侧边面板 📄 按钮 | 总结当前页 |
| 侧边面板 ⚙️ 按钮 | 设置（Bridge URL、字体、语言、页面样式管理） |

首次打开若显示未连接，点底部横幅重连，或在 ⚙️ 设置里确认 Bridge URL（默认 `ws://127.0.0.1:18731`）。

## Agent 工具（18 个）

pi 通过自定义工具与浏览器/本地交互。内置的 `read`/`bash`/`edit`/`write` 已禁用（`safe_read` 替代 `read`，其余完全禁用），agent 无法执行 shell 或修改本地文件。

### 📖 读取
| 工具 | 功能 |
|------|------|
| `read_page_content` | 读页面内容（HTML 走 Readability；**PDF 自动提取，扫描件渲染图片**） |
| `read_selection` | 读用户选中的文字 |
| `get_page_headings` | 页面标题大纲（h1-h3） |
| `get_page_metadata` | OpenGraph / meta 标签 |
| `read_current_css` | 读 pi 自己注入的 CSS 快照 |
| `read_element_styles` | 读元素真实 computed CSS + CSS 变量 |

### 🎨 页面修改（per-origin 持久化）
| 工具 | 功能 |
|------|------|
| `modify_page_css` | 注入 CSS（追加到站点快照，刷新自动恢复） |
| `modify_page_style` | 改特定元素 inline style |
| `toggle_dark_mode` | 暗色模式 |
| `highlight_elements` | 高亮（outline/background/glow） |
| `remove_elements` | 隐藏元素 |
| `revert_page_modifications` | 清空该站点全部 CSS |

### 🖱️ 交互
| 工具 | 功能 |
|------|------|
| `click_element` | 点击（`<a>` 自动导航；其他走 CDP 真实鼠标事件） |
| `navigate_to_url` | 当前标签页跳转 |
| `list_tabs` | 列出所有标签页 |

### 📁 本地文件（硬过滤敏感路径）
| 工具 | 功能 |
|------|------|
| `safe_read` | 读文件（500KB 上限；屏蔽 `~/.ssh`、`auth.json`、`.env`、私钥、含 secret/token 的文件名） |
| `list_dir` | 列目录（隐藏敏感条目，屏蔽 `~/.ssh`、`~/.gnupg`） |

### ⚡ 脚本
| 工具 | 功能 |
|------|------|
| `inject_script` | 在页面 MAIN world 执行 JS（绕过 CSP） |

## 安全设计

- **能力最小化**：禁用 `bash`/`edit`/`write`，无 shell 执行、无文件修改
- **`safe_read` 三层防御**：① 能力层禁用危险工具 → ② 工具层硬过滤敏感路径（代码级保证）→ ③ 指令层系统提示约束 agent 行为
- **防 prompt injection**：系统提示要求 agent 只响应聊天里的用户指令，忽略网页内容里的"读文件"诱导
- **不外泄**：禁止把文件内容写进页面或发往外部 URL

## 项目结构

```
pi-chrome-extension/
├── ARCHITECTURE.md                # 架构文档
├── bridge/                        # 本地桥接服务
│   └── src/
│       ├── config.ts              # 配置 + 环境变量
│       ├── types.ts               # WS 协议类型
│       ├── context.ts             # 页面上下文格式化
│       ├── pdf.ts                 # clawpdf 封装（PDF 提取）
│       ├── pi-agent.ts            # ★ pi SDK 集成 + 工具定义 + 系统提示
│       ├── ws-server.ts           # ★ WebSocket 服务器
│       └── index.ts               # 入口
└── extension/                     # Chrome 扩展（WXT）
    ├── wxt.config.ts              # outDir=output/，权限，快捷键
    ├── entrypoints/
    │   ├── background/index.ts    # Service Worker（消息路由 + WS）
    │   ├── content-script.content/ # 页面提取 + PDF 检测 + 修改执行
    │   └── sidepanel/index.html   # 聊天 UI + 设置（HTML+JS 内联）
    ├── assets/icon-source.svg     # 图标设计源
    └── src/shared/types.ts        # 共享类型
```

## 环境变量（Bridge）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_CHROME_PORT` | WebSocket 端口 | `18731` |
| `PI_CHROME_HOST` | 监听地址 | `127.0.0.1` |
| `PI_CHROME_TOKEN` | 认证令牌（可选） | 无 |
| `PI_CHROME_PROVIDER` | 默认 LLM provider | 由 pi 设置决定 |
| `PI_CHROME_MODEL` | 默认模型 | 由 pi 设置决定 |
| `PI_CHROME_MAX_CONTEXT` | 页面内容最大长度 | `50000` |

## 技术栈

- **Extension**：TypeScript、WXT、原生 HTML/JS（marked + KaTeX 渲染）
- **Bridge**：Node.js 22+、pi SDK（`@earendil-works/pi-coding-agent`）、ws、clawpdf（PDFium WASM）
- **通信**：WebSocket + JSONL 协议

## 开发

```bash
# Bridge（热重载）
cd bridge && npm run dev

# 扩展（构建后到 chrome://extensions 重新加载）
cd extension && npm run build
```

Bridge 改动由 tsx watch 自动重载；扩展改动需在 `chrome://extensions` 点 🔄 重新加载。

## 后台运行

日常使用无需保留终端窗口，可将 bridge 注册为 **systemd 用户服务**：

```bash
cd bridge

# 安装（build + 写入 service 单元 + 重载 systemd）
./scripts/install-service.sh

# 立即启动并设置开机自启
systemctl --user enable --now pi-bridge

# 查看状态
systemctl --user status pi-bridge

# 查看日志
journalctl --user -u pi-bridge -f

# 停止 / 关闭自启
systemctl --user stop  pi-bridge
systemctl --user disable pi-bridge

# 完全移除服务
./scripts/uninstall-service.sh
```

服务以生产模式运行 `node bridge/dist/index.js`，崩溃后自动重启。

> **macOS / Windows**：systemd 仅限 Linux。替代方案：
> - **macOS**：使用 `launchd`（在 `~/Library/LaunchAgents/` 下放一个 `.plist`）
> - **Windows**：使用 NSSM 或任务计划程序
> - **通用**：`nohup node dist/index.js > bridge.log 2>&1 &`（简单但无自动重启）

## License

MIT
