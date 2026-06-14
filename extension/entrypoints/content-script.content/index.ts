/**
 * Content Script
 *
 * WXT requires content script entry points to use defineContentScript.
 * This wraps the main logic inline instead of using dynamic imports.
 */

import { defineContentScript } from "wxt/utils/define-content-script";
import type { PageContext } from "../../src/shared/types";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  main() {
    try {
      console.log("[pi] Content script loaded");

      // ═══════════════════════════════════════════════════════════════════
      //  Page Context Extraction
      // ═══════════════════════════════════════════════════════════════════

      let ReadabilityCtor: any = null;

      async function initReadability(): Promise<void> {
        if (ReadabilityCtor) return;
        try {
          // @mozilla/readability is bundled by WXT, no dynamic import needed
          const { Readability } = await import("@mozilla/readability");
          ReadabilityCtor = Readability;
          console.log("[pi] Readability loaded");
        } catch {
          console.warn("[pi] @mozilla/readability not available, using fallback extraction");
        }
      }

    function getPageContext(): PageContext {
      const now = Date.now();
      const ctx: PageContext = {
        url: location.href,
        title: document.title,
        extractedAt: now,
        viewport: { width: innerWidth, height: innerHeight },
        meta: getMetaTags(),
      };

      if (ReadabilityCtor) {
        const result = extractArticle();
        if (result) {
          Object.assign(ctx, result);
          ctx.length = result.textContent.length;
          return ctx;
        }
      }

      const text = fallbackExtract();
      ctx.textContent = text;
      ctx.length = text.length;
      return ctx;
    }

    function extractArticle(): Pick<PageContext, "title" | "content" | "textContent" | "excerpt" | "byline"> | null {
      const doc = document.cloneNode(true) as Document;
      const article = new ReadabilityCtor(doc).parse();
      if (!article) return null;
      return {
        title: article.title || document.title,
        content: article.content || "",
        textContent: article.textContent || "",
        excerpt: article.excerpt || "",
        byline: article.byline || undefined,
      };
    }

    function fallbackExtract(): string {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script, style, nav, footer, header, aside, .ad, .sidebar").forEach((e) => e.remove());
      const main = clone.querySelector("article, main, [role='main']") || clone;
      return main.textContent?.replace(/\s+/g, " ").trim() || "";
    }

    function getMetaTags(): Record<string, string> {
      const m: Record<string, string> = {};
      document.querySelectorAll("meta").forEach((el) => {
        const k = el.getAttribute("name") || el.getAttribute("property") || "";
        const v = el.getAttribute("content") || "";
        if (k && v) m[k] = v;
      });
      return m;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Page Modification Engine
    // ═══════════════════════════════════════════════════════════════════

    interface Mod {
      id: string;
      revert(): void;
    }

    const mods: Mod[] = [];

    function addStyle(css: string, id?: string): string {
      const style = document.createElement("style");
      const sid = id ?? `pi-${Date.now()}`;
      style.id = sid;
      style.textContent = css;
      document.head.appendChild(style);
      mods.push({ id: sid, revert: () => style.remove() });
      return sid;
    }

    function execTool(toolName: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
      try {
        switch (toolName) {
          case "read_page_content": {
            const ctx = getPageContext();
            return { text: `# ${ctx.title}\n\n${ctx.textContent || ctx.content || ""}` };
          }

          case "read_selection": {
            const sel = getSelection()?.toString().trim();
            return { text: sel || "(no selection)" };
          }

          case "get_page_headings": {
            const lines: string[] = [];
            document.querySelectorAll("h1,h2,h3").forEach((h) => {
              const level = h.tagName.toLowerCase();
              const pad = level === "h1" ? "" : level === "h2" ? "  " : "    ";
              lines.push(`${pad}${level.toUpperCase()}: ${h.textContent?.trim() || ""}`);
            });
            return { text: lines.join("\n") || "(no headings)" };
          }

          case "get_page_metadata": {
            const meta = getMetaTags();
            return { text: Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n") || "(no metadata)" };
          }

          case "modify_page_css": {
            const revertable = args.revertable !== false;
            if (revertable) {
              addStyle(args.css as string);
            } else {
              const style = document.createElement("style");
              style.textContent = args.css as string;
              document.head.appendChild(style);
            }
            return { text: "✅ CSS applied" };
          }

          case "modify_page_style": {
            const sel = args.selector as string;
            const styles = args.styles as Record<string, string>;
            const els = document.querySelectorAll(sel);
            if (!els.length) return { text: `❌ No elements for "${sel}"`, isError: true };
            const originals = new Map<HTMLElement, Record<string, string>>();
            els.forEach((e) => {
              const el = e as HTMLElement;
              const orig: Record<string, string> = {};
              for (const [prop, val] of Object.entries(styles)) {
                orig[prop] = el.style.getPropertyValue(prop);
                el.style.setProperty(prop, val);
              }
              originals.set(el, orig);
            });
            mods.push({
              id: `style-${Date.now()}`,
              revert: () => originals.forEach((orig, el) => {
                for (const [prop, val] of Object.entries(orig)) {
                  val ? el.style.setProperty(prop, val) : el.style.removeProperty(prop);
                }
              }),
            });
            return { text: `✅ Modified ${els.length} element(s) matching "${sel}"` };
          }

          case "toggle_dark_mode": {
            const enable = args.enable as boolean | undefined;
            const existing = document.getElementById("pi-dark");
            if (enable === false || (enable === undefined && existing)) {
              existing?.remove();
              return { text: "☀️ Dark mode off" };
            }
            if (!existing) {
              addStyle(`
                html { filter: invert(1) hue-rotate(180deg); background: #fff; }
                img, video, canvas, svg, [style*="background-image"] { filter: invert(1) hue-rotate(180deg); }
              `, "pi-dark");
            }
            return { text: "🌙 Dark mode on" };
          }

          case "highlight_elements": {
            const selectors = args.selectors as string[];
            const color = (args.color as string) || "#ffeb3b";
            const style_ = (args.style as string) || "outline";
            const css = selectors.map((s) => {
              const v = style_ === "background" ? `background: ${color} !important;`
                : style_ === "glow" ? `box-shadow: 0 0 15px ${color} !important;`
                : `outline: 3px solid ${color} !important; outline-offset: 2px !important;`;
              return `${s} { ${v} }`;
            }).join("\n");
            addStyle(css);
            return { text: `✅ Highlighted ${selectors.length} set(s)` };
          }

          case "remove_elements": {
            const selectors = args.selectors as string[];
            const css = selectors.map((s) => `${s} { display: none !important; }`).join("\n");
            addStyle(css);
            return { text: `✅ Hidden ${selectors.length} set(s)` };
          }

          case "revert_page_modifications": {
            let n = 0;
            for (let i = mods.length - 1; i >= 0; i--) {
              try { mods[i].revert(); n++; } catch { /* skip */ }
            }
            mods.length = 0;
            return { text: `↩️ Reverted ${n} modification(s)` };
          }

          case "inject_script": {
            const script = document.createElement("script");
            script.textContent = args.code as string;
            document.body.appendChild(script);
            script.remove();
            return { text: "✅ Script executed" };
          }

          default:
            return { text: `❌ Unknown tool: ${toolName}`, isError: true };
        }
      } catch (err) {
        return { text: `❌ Error: ${(err as Error).message}`, isError: true };
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Message Listener
    // ═══════════════════════════════════════════════════════════════════

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      try {
        switch (msg.type) {
          case "get_page_context":
            sendResponse({ pageContext: getPageContext() });
            break;

          case "get_element_coords": {
            const sel = msg.selector as string;
            let el = document.querySelector(sel);
            // If text filter provided, find matching element
            if (!el && msg.text) {
              const text = (msg.text as string).toLowerCase();
              el = Array.from(document.querySelectorAll(sel || "*"))
                .find((e) => e.textContent?.toLowerCase().includes(text)) ?? null;
            }
            if (!el) {
              sendResponse({ error: `Element not found: ${sel}${msg.text ? ` (text: "${msg.text}")` : ""}` });
              break;
            }
            // Scroll into view
            el.scrollIntoView({ behavior: "instant", block: "center" });
            const rect = el.getBoundingClientRect();
            const tagName = el.tagName.toLowerCase();
            const text = (el as HTMLElement).innerText?.slice(0, 200) || "";
            const href = (el as HTMLAnchorElement).href || "";
            sendResponse({
              x: rect.left + rect.width / 2 + window.scrollX,
              y: rect.top + rect.height / 2 + window.scrollY,
              tagName,
              text: text.trim(),
              href,
              width: rect.width,
              height: rect.height,
            });
            break;
          }

          case "execute_tool": {
            const result = execTool(msg.toolName, msg.args);
            sendResponse({
              content: [{ type: "text" as const, text: result.text }],
              isError: result.isError ?? false,
            });
            break;
          }

          default:
            sendResponse(undefined);
        }
      } catch (err) {
        console.error("[pi] Error handling message:", err);
        sendResponse({
          content: [{ type: "text" as const, text: `❌ Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
    });

    // ═══════════════════════════════════════════════════════════════════
    //  Auto-send page context
    // ═══════════════════════════════════════════════════════════════════

    async function notifyReady() {
      await initReadability();
      const ctx = getPageContext();
      chrome.runtime.sendMessage({ type: "page_context_ready", pageContext: ctx }).catch(() => {});
    }

    if (document.readyState === "complete") {
      notifyReady();
    } else {
      addEventListener("load", () => notifyReady());
    }

    document.addEventListener("DOMContentLoaded", () => initReadability());
    initReadability();
    console.log("[pi] Content script ready");
  } catch (err) {
    console.error("[pi] Content script error:", err);
  }
  },
});
