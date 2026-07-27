# pi Browser Companion

**English** | [中文](./README.zh-CN.md)

**pi Browser Companion** is a Chrome extension that brings the [pi coding agent](https://pi.dev) into your browser. Collaborate with pi in real time while you browse:

- **📄 Summarize & chat** — extract page content, generate summaries, discuss what's on the page
- **🎨 Modify pages** — let pi adjust styles, layout, and visuals (CSS persists per-site, reapplied on refresh)
- **📑 PDF support** — auto-extract PDF text; scanned PDFs render page images for the vision model
- **📁 Local files** — controlled `safe_read` / `list_dir` with hard filtering of sensitive paths (`~/.ssh`, `auth.json`, `.env`, …)
- **➗ Math** — KaTeX renders `$...$` / `$$...$$`
- **🌐 Language** — set the reply language (`auto` to follow the page, or `中文` / `English` / …)

## Architecture

```
┌─ Browser (Chrome) ─────────────────────────────┐
│  ┌───────────────┐  ┌────────────┐             │
│  │  Side Panel   │  │ Content    │             │
│  │  (chat UI)    │  │ Script     │             │
│  └───────┬───────┘  └─────┬──────┘             │
│          │ chrome.runtime  │                    │
│   ┌──────▼──────────────▼──────┐               │
│   │  Background Service Worker │               │
│   │  (routing + WS client)     │               │
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

Three layers: **Extension ↔ Bridge (local Node service, WebSocket) ↔ pi SDK / LLM**. All LLM processing runs locally in the Bridge; the extension only handles browser interaction.

## Quick start

### Prerequisites

| Dep | Notes |
|-----|-------|
| Node.js 22+ | to run the Bridge |
| pi auth | `~/.pi/agent/auth.json` (set up via `pi auth login`; supports zai / opencode / github-copilot / anthropic / openai …) |

> The Bridge discovers credentials under `~/.pi/agent/` via `AuthStorage.create()` — no API key needed in the extension.

### 1. Build & run the Bridge

```bash
cd bridge
npm install        # includes pi SDK + clawpdf
npm run dev        # tsx watch, auto-reloads on change
```

Listens on `ws://127.0.0.1:18731` by default. On success it prints `pi agent initialized (model: ...)`.

### 2. Build & load the extension

```bash
cd extension
npm install
npm run build      # output in output/chrome-mv3/
```

> Output goes to the non-dotted `output/` (not WXT's default `.output/`) so Chrome's "Load unpacked" directory picker can see it directly.

**Load into Chrome:**
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `extension/output/chrome-mv3/`
3. The π icon appears in the toolbar

### 3. Use it

| Action | Effect |
|--------|--------|
| Click the π icon / `Alt+Shift+P` | open the side panel |
| 📄 button | summarize the current page |
| ⚙️ button | settings (Bridge URL, font, language, page-style management) |

If it shows disconnected on first open, click the banner to reconnect, or check the Bridge URL in ⚙️ (default `ws://127.0.0.1:18731`).

## Agent tools (18)

pi interacts with the browser / local FS through custom tools. The built-in `read` / `bash` / `edit` / `write` are disabled (`safe_read` replaces `read`; the rest are fully off) — the agent cannot run a shell or modify local files.

### 📖 Read
| Tool | What it does |
|------|--------------|
| `read_page_content` | read page content (HTML via Readability; **PDF auto-extracted, scanned docs get page images**) |
| `read_selection` | read the user's selected text |
| `get_page_headings` | page heading outline (h1–h3) |
| `get_page_metadata` | OpenGraph / meta tags |
| `read_current_css` | read pi's own injected CSS snapshot |
| `read_element_styles` | read an element's real computed CSS + CSS variables |

### 🎨 Page modification (persisted per-origin)
| Tool | What it does |
|------|--------------|
| `modify_page_css` | inject CSS (appended to the site snapshot, reapplied on refresh) |
| `modify_page_style` | change inline styles of specific elements |
| `toggle_dark_mode` | dark mode |
| `highlight_elements` | highlight (outline / background / glow) |
| `remove_elements` | hide elements |
| `revert_page_modifications` | clear all CSS for this site |

### 🖱️ Interaction
| Tool | What it does |
|------|--------------|
| `click_element` | click (`<a>` auto-navigates; others use CDP real mouse events) |
| `navigate_to_url` | navigate the current tab |
| `list_tabs` | list all open tabs |

### 📁 Local files (hard-filtered)
| Tool | What it does |
|------|--------------|
| `safe_read` | read a file (500KB cap; blocks `~/.ssh`, `auth.json`, `.env`, private keys, names containing secret/token) |
| `list_dir` | list a directory (hides sensitive entries; blocks `~/.ssh`, `~/.gnupg`) |

### ⚡ Script
| Tool | What it does |
|------|--------------|
| `inject_script` | run JS in the page's MAIN world (bypasses CSP) |

## Security design

- **Capability minimization**: `bash` / `edit` / `write` disabled — no shell, no file modification
- **`safe_read` defense in depth**: ① capability layer disables dangerous tools → ② tool layer hard-filters sensitive paths (code-level guarantee) → ③ instruction layer (system prompt) constrains behavior
- **Anti prompt injection**: the system prompt tells the agent to act only on chat messages, ignoring "read this file" instructions embedded in web content
- **No exfiltration**: file contents must never be written into the page or sent to external URLs

## Project structure

```
pi-chrome-extension/
├── ARCHITECTURE.md                # architecture doc
├── bridge/                        # local bridge service
│   └── src/
│       ├── config.ts              # config + env vars
│       ├── types.ts               # WS protocol types
│       ├── context.ts             # page-context formatting
│       ├── pdf.ts                 # clawpdf wrapper (PDF extraction)
│       ├── pi-agent.ts            # ★ pi SDK integration + tools + system prompt
│       ├── ws-server.ts           # ★ WebSocket server
│       └── index.ts               # entry
└── extension/                     # Chrome extension (WXT)
    ├── wxt.config.ts              # outDir=output/, permissions, shortcuts
    ├── entrypoints/
    │   ├── background/index.ts    # service worker (routing + WS)
    │   ├── content-script.content/ # page extraction + PDF detection + mods
    │   └── sidepanel/index.html   # chat UI + settings (inline HTML/JS)
    ├── assets/icon-source.svg     # icon design source
    └── src/shared/types.ts        # shared types
```

## Environment variables (Bridge)

| Var | Description | Default |
|-----|-------------|---------|
| `PI_CHROME_PORT` | WebSocket port | `18731` |
| `PI_CHROME_HOST` | bind address | `127.0.0.1` |
| `PI_CHROME_TOKEN` | auth token (optional) | none |
| `PI_CHROME_PROVIDER` | default LLM provider | from pi settings |
| `PI_CHROME_MODEL` | default model | from pi settings |
| `PI_CHROME_MAX_CONTEXT` | max page content length | `50000` |

## Tech stack

- **Extension**: TypeScript, WXT, vanilla HTML/JS (marked + KaTeX rendering)
- **Bridge**: Node.js 22+, pi SDK (`@earendil-works/pi-coding-agent`), ws, clawpdf (PDFium WASM)
- **Transport**: WebSocket + JSONL protocol

## Development

```bash
# Bridge (hot reload)
cd bridge && npm run dev

# Extension (rebuild, then reload at chrome://extensions)
cd extension && npm run build
```

Bridge changes auto-reload via tsx watch; extension changes need a 🔄 reload at `chrome://extensions`.

## License

MIT
