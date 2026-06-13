# pi Chrome Extension — 架构设计文档

## 概述

**pi Chrome Extension** 是一个浏览器插件，将 [pi coding agent](https://pi.dev) 的能力带入浏览器。用户可以在阅读网页时：

1. **总结文章摘要** — 自动提取网页正文并生成摘要
2. **与 pi 对话** — 围绕网页内容进行深入的对话讨论
3. **修改网页界面** — 让 pi 直接操作页面 DOM/CSS，改变网页外观和布局

整个系统由三部分组成：
- **Chrome Extension**（浏览器端 UI + 内容脚本）
- **Bridge Service**（本地 Node.js 桥接服务）
- **pi Agent**（LLM 驱动的编码助手）

---

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│                   Browser (Chrome)                    │
│  ┌──────────────────────┐  ┌──────────────────────┐  │
│  │   Popup / Side Panel  │  │    Content Script     │  │
│  │  (React/Tailwind UI)  │  │  (注入到当前页面)      │  │
│  └─────────┬────────────┘  └──────────┬───────────┘  │
│            │                           │              │
│            └──────────┬────────────────┘              │
│                       │ Chrome Messages API           │
│              ┌────────▼────────┐                      │
│              │  Background      │                      │
│              │  Script (SW)     │                      │
│              └────────┬────────┘                      │
│                       │ WebSocket                     │
└───────────────────────┼───────────────────────────────┘
                        │
┌───────────────────────▼───────────────────────────────┐
│              Bridge Service (local Node.js)            │
│                                                       │
│  ┌────────────────┐  ┌──────────────────────────────┐ │
│  │  WebSocket       │  │  pi SDK Integration          │ │
│  │  Server (ws)     │◄─┤                              │ │
│  └────────────────┘  │  ├─ AgentSession (对话管理)    │ │
│                       │  ├─ Custom Tools (页面工具)    │ │
│                       │  ├─ ResourceLoader (资源加载)  │ │
│                       │  └─ Session Persistence       │ │
│                       └──────────────────────────────┘ │
│                                  │                     │
│                                  ▼                     │
│                        ┌──────────────────┐            │
│                        │  LLM Provider     │            │
│                        │  (Anthropic/      │            │
│                        │   OpenAI/etc.)    │            │
│                        └──────────────────┘            │
└───────────────────────────────────────────────────────┘
```

### 组件职责

#### 1. Chrome Extension

| 组件 | 技术 | 职责 |
|------|------|------|
| **Background Script** | Service Worker | WebSocket 连接管理，消息路由，生命周期管理 |
| **Content Script** | TypeScript + Readability | 提取网页正文，执行页面修改命令，注入 UI 元素 |
| **Side Panel** | React + Tailwind | 完整的聊天界面，摘要展示，修改控制 |
| **Popup** | React + Tailwind | 快速操作入口，状态预览 |
| **Options Page** | React + Tailwind | API 配置，桥接地址，主题设置 |

#### 2. Bridge Service

| 模块 | 职责 |
|------|------|
| **WebSocket Server** | 接受扩展连接，管理会话，消息转发 |
| **Pi Agent Wrapper** | 使用 pi SDK 创建 AgentSession，管理对话状态 |
| **Custom Tools** | 注册 pi 可调用的浏览器工具 |
| **Session Manager** | 持久化会话历史（复用 pi 的 JSONL 格式） |

#### 3. pi Agent

通过 SDK 集成，在 Bridge Service 进程中直接运行，无需子进程。

使用的 pi SDK 核心 API：
```
createAgentSession()
session.prompt()
session.subscribe()
session.steer() / session.followUp()
Custom tools via pi.registerTool()
ResourceLoader
```

---

## 通信协议

### Extension ↔ Bridge (WebSocket JSONL)

每个消息一行 JSON，基于 pi RPC 协议扩展。

#### 身份认证

```
C → S: { "type": "auth", "token": "user-configured-token" }
S → C: { "type": "auth_ok", "sessionId": "..." }
```

#### 对话消息

```
C → S: {
  "type": "prompt",
  "message": "总结这篇文章",
  "pageContext": {       // 当前页面上下文
    "url": "https://...",
    "title": "...",
    "content": "...",    // Readability 提取的内容 (HTML)
    "textContent": "...", // 纯文本版本
    "selection": "...",  // 用户选中的文字（可选）
    "extractedAt": 1234567890
  },
  "images": []           // 页面截图或其他图片
}

S → C (streaming): { "type": "text_delta", "delta": "这篇文章..." }
S → C (streaming): { "type": "text_delta", "delta": "主要讨论了..." }
S → C (done):      { "type": "agent_end", "messages": [...] }
```

#### 工具调用（页面操作）

当 pi 调用自定义工具时，Bridge 通过 WebSocket 转发给 Extension：

```
S → C: {
  "type": "tool_call",
  "toolCallId": "call_xxx",
  "toolName": "modify_page",
  "args": { "css": "body { background: #1a1a2e; }" }
}

C → S: {
  "type": "tool_result",
  "toolCallId": "call_xxx",
  "content": [{ "type": "text", "text": "CSS injected successfully" }],
  "isError": false
}
```

#### 错误处理

```
S → C: { "type": "error", "code": "PROVIDER_ERROR", "message": "..." }
```

---

## 自定义工具箱

pi 通过以下自定义工具与浏览器页面交互：

### 页面读取工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `read_page_content` | 读取页面正文（Readability 提取） | — |
| `read_page_metadata` | 读取页面元数据（SEO meta, OpenGraph） | — |
| `read_selection` | 读取用户当前选中的文字 | — |
| `read_dom` | 读取指定元素的 HTML/CSS 状态 | `{ selector: string, property?: string }` |
| `capture_screenshot` | 截取当前页面可视区域 | `{ format?: "png"\|"jpeg", quality?: number }` |

### 页面修改工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `modify_page_css` | 注入自定义 CSS | `{ css: string, revertable?: boolean }` |
| `modify_page_style` | 修改指定元素的样式 | `{ selector: string, styles: Record<string,string> }` |
| `inject_script` | 在页面中执行 JavaScript | `{ code: string }` |
| `highlight_elements` | 高亮指定元素 | `{ selectors: string[], color?: string }` |
| `toggle_dark_mode` | 切换深色模式 | `{ enable?: boolean }` |
| `remove_elements` | 移除指定元素 | `{ selectors: string[] }` |

### 辅助工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `get_page_links` | 获取页面所有链接 | `{ filter?: string }` |
| `get_page_images` | 获取页面图片列表 | — |
| `get_page_headings` | 获取文章标题结构 | — |

---

## 核心数据流

### 流程 1：文章摘要

```
用户点击 "Summarize" 按钮
        │
        ▼
Content Script 使用 Readability 提取文章
  { title, content, textContent, byline, excerpt }
        │
        ▼
发送到 Background Script
        │
        ▼
Background 通过 WebSocket 发送到 Bridge
  { type: "prompt", message: "请用中文总结这篇文章",
    pageContext: {...} }
        │
        ▼
Bridge 将 pageContext 注入到 pi 的系统提示/上下文中
  + 注册自定义工具 (read_page_content, modify_page_css ...)
  + 调用 session.prompt("请用中文总结这篇文章")
        │
        ▼
pi Agent 开始处理：
  1. 分析 pageContext 中的文章内容
  2. 生成结构化的摘要（标题、核心观点、结论）
  3. 可能需要调用 read_page_content 获取更多详情
        │
        ▼
结果通过 WebSocket 流式返回：
  { type: "text_delta", delta: "..." }
        │
        ▼
Side Panel 展示最终摘要（Markdown 渲染）
```

### 流程 2：对话讨论

```
用户在 Side Panel 中输入问题
  "这篇文章的核心论点是什么？"
        │
        ▼
消息 + pageContext → Bridge → pi SDK
        │
        ▼
pi 结合对话历史和页面上下文生成回答
  (使用之前注入的 pageContext，不需要重新发送)
        │
        ▼
流式返回 → Side Panel 展示
        │
        ▼
用户连续追问...
  pi 保持会话上下文，可以进行深度讨论
```

### 流程 3：网页界面修改

```
用户输入： "把这个网页改成深色模式，字体调大一点"
        │
        ▼
Bridge → pi SDK
        │
        ▼
pi 分析页面需求，决定调用工具：
  1. modify_page_css({ css: "body { background: #1a1a2e; color: #e0e0e0; } ..." })
  2. modify_page_style({ selector: "body", styles: { "font-size": "18px" } })
        │
        ▼
Bridge 通过 WebSocket 发送 tool_call
        │
        ▼
Background Script → Content Script
        │
        ▼
Content Script 在页面中执行修改：
  - 创建 <style> 标签注入 CSS
  - 或直接修改元素 style 属性
  - 记录修改历史以便撤销
        │
        ▼
结果返回 → pi 确认修改成功
        │
        ▼
pi 回复： "已为你应用深色模式并调大了字体 ☑️"
```

---

## 页面上下文管理

为了高效利用 LLM 上下文窗口，页面内容管理策略：

### 初始注入
- 首次对话时发送完整 pageContext
- Bridge 端的 pi 扩展将其注入为系统消息的上下文

### 上下文分层

```
Level 0: 页面元数据（始终保留）
  - URL, title, description, favicon

Level 1: 文章摘要/关键信息（精简）
  - Readability 提取的 excerpt + 前 2000 字符
  - 标题结构 (h1-h3)

Level 2: 全文（按需提供）
  - 完整文章内容
  - 仅在用户深入追问时提供
```

### 导航处理
- 用户切换页面时，通过 `pageContext` 事件通知 Bridge
- Bridge 可以自动开启新对话轮次，或通过 `steer` 消息告知 pi 页面已变更

---

## 会话与持久化

### 对话会话
- 利用 pi SDK 的 `session.prompt()` 管理对话
- 每标签页/域名的对话自动分组
- 会话保存到本地文件（复用 pi JSONL 格式）

### 页面修改历史
- Content Script 维护修改栈（`modificationStack`）
- 支持撤销（`Ctrl+Z` 或通过 pi 指令撤销）
- 页面刷新后可以自动恢复（需用户配置）

### 偏好设置
- 默认 LLM 模型和提供商
- 深色模式开关
- 摘要长度偏好
- 自动摘要（页面加载后自动生成）

---

## 安全性考虑

1. **页面修改沙箱**：
   - Content Script 运行在隔离的 world 中
   - 只能通过标准 DOM API 修改页面
   - 不注入外部资源（除非用户明确允许）

2. **本地桥接服务**：
   - 仅监听 `127.0.0.1`（不暴露到网络）
   - 可选 Token 认证
   - 使用 pi 的权限系统（`pi.registerTool` 的权限控制）

3. **API Key 安全**：
   - 通过 pi 现有的 `auth.json` 管理
   - 或通过扩展的选项页面配置
   - 支持环境变量

4. **内容隐私**：
   - 所有页面内容仅发送到本地 Bridge Service
   - 不在云端存储
   - 使用 HTTPS/WSS 连接本地服务（可选）

---

## 技术栈

### Extension
- **框架**: React 18 + TypeScript
- **样式**: Tailwind CSS
- **构建**: Vite + @crxjs/vite-plugin (或 WXT)
- **包管理**: pnpm
- **核心库**: 
  - `@mozilla/readability` — 文章提取
  - `react-markdown` — 渲染 Markdown
  - `lucide-react` — 图标

### Bridge Service
- **运行时**: Node.js 22+
- **框架**: 无（纯 Node.js + ws）
- **SDK**: `@earendil-works/pi-coding-agent`
- **WebSocket**: `ws` 库
- **CLI**: `commander` 或手写

### pi Agent
- 通过 SDK 集成 (`createAgentSession`)
- 注册自定义工具 (`pi.registerTool`)
- 使用事件订阅获取流式输出 (`session.subscribe`)

---

## 目录结构

```
pi-chrome-extension/
├── package.json                    # 根 package（workspace）
├── ARCHITECTURE.md                 # 本文档
├── README.md                       # 项目说明
│
├── extension/                      # Chrome Extension
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── manifest.json               # Chrome Manifest V3
│   └── src/
│       ├── background/
│       │   ├── index.ts            # Service Worker 入口
│       │   ├── websocket.ts        # WebSocket 连接管理
│       │   └── router.ts           # 消息路由
│       ├── content-script/
│       │   ├── index.ts            # Content Script 入口
│       │   ├── page-extractor.ts   # 文章提取 (Readability)
│       │   ├── page-modifier.ts    # 页面修改执行器
│       │   └── modification-stack.ts # 修改历史栈
│       ├── popup/
│       │   ├── index.html
│       │   ├── Popup.tsx           # 弹出面板
│       │   └── components/         # 共享 UI 组件
│       ├── sidepanel/
│       │   ├── index.html
│       │   ├── SidePanel.tsx       # 侧边聊天面板
│       │   ├── ChatView.tsx        # 聊天视图
│       │   ├── SummaryView.tsx     # 摘要视图
│       │   └── ModificationControls.tsx # 修改控制
│       ├── options/
│       │   ├── index.html
│       │   └── Options.tsx         # 设置页面
│       ├── shared/
│       │   ├── types.ts            # 共享类型
│       │   ├── messages.ts         # 消息协议定义
│       │   └── storage.ts          # Chrome Storage 封装
│       └── assets/
│           └── icons/              # 插件图标
│
└── bridge/                         # Local Bridge Service
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts                # 入口
    │   ├── ws-server.ts            # WebSocket 服务器
    │   ├── pi-agent.ts             # pi SDK 封装
    │   ├── tools/
    │   │   ├── index.ts            # 工具注册入口
    │   │   ├── read-page.ts        # read_page_content 工具
    │   │   ├── modify-page.ts      # modify_page_css 等工具
    │   │   └── capture.ts          # capture_screenshot 工具
    │   ├── context.ts              # 页面上下文管理
    │   └── config.ts               # 配置
    └── sessions/                   # pi 会话存储目录
```

---

## 开发路线图

### Phase 1: 基础架构
- [ ] Bridge Service: WebSocket 服务器 + pi SDK 集成
- [ ] Extension: Background Script + WebSocket 连接
- [ ] Content Script: 文章提取 (Readability)
- [ ] 基础对话能力（Side Panel 聊天）

### Phase 2: 核心功能
- [ ] 文章摘要功能
- [ ] 页面修改工具集
- [ ] 页面上下文管理
- [ ] 流式输出展示

### Phase 3: 体验优化
- [ ] 修改历史/撤销
- [ ] 会话管理
- [ ] 多标签页支持
- [ ] Popup 快速操作

### Phase 4: 进阶功能
- [ ] 页面截图能力
- [ ] 多模型切换
- [ ] 自定义提示词模板
- [ ] i18n 国际化

---

## 与 pi 的关系

本项目是 pi 生态的一个**扩展应用**，展示了 pi SDK 在非终端环境中的使用方式。

- **不修改 pi 核心** — 完全通过 SDK + Extensions API 集成
- **复用 pi 的会话格式** — 对话记录与 pi 原生格式兼容
- **回馈生态** — 可发布为 pi package (pi-chrome-bridge)

更多 pi 自定义能力参考：
- [Extensions API](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)
- [SDK](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/sdk.md)
- [Custom Tools](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md#custom-tools)
