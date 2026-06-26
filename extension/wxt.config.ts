import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  // Chrome 的"加载已解压扩展"选择器默认隐藏点开头目录，
  // 所以输出到不带点的 output/ 而非 WXT 默认的 .output/。
  outDir: "output",
  extensionApi: "chrome",
  modules: [],
  manifestVersion: 3,
  manifest: {
    name: "pi Browser Companion",
    description: "Your AI reading companion - summarize, chat, and customize web design with pi",
    icons: {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_title: "pi Companion",
      default_icon: {
        "16": "icons/icon-16.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    },
    permissions: ["storage", "sidePanel", "tabs", "activeTab", "scripting", "alarms", "debugger"],
    host_permissions: ["<all_urls>"],
    commands: {
      toggle_side_panel: {
        suggested_key: { default: "Alt+Shift+P", mac: "Alt+Shift+P" },
        description: "Toggle pi side panel",
      },
    },
  },
});
