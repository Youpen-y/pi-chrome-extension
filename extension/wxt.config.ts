import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  extensionApi: "chrome",
  modules: [],
  manifestVersion: 3,
  manifest: {
    name: "pi Browser Companion",
    description: "Your AI reading companion - summarize, chat, and customize web design with pi",
    icons: {
      "16": "icons/icon.svg",
      "48": "icons/icon.svg",
      "128": "icons/icon.svg",
    },
    action: {
      default_title: "pi Companion",
    },
    permissions: ["storage", "sidePanel", "tabs", "activeTab", "scripting", "alarms"],
    host_permissions: ["<all_urls>"],
    commands: {
      toggle_side_panel: {
        suggested_key: { default: "Alt+Shift+P", mac: "Alt+Shift+P" },
        description: "Toggle pi side panel",
      },
    },
  },
});
