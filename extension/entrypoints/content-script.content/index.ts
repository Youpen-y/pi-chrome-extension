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

      // PDF pages have no DOM text — surface a hint so the AI knows to call
      // read_page_content (which fetches bytes and extracts via the bridge).
      if (isPdfPage()) {
        ctx.textContent = "[This page is a PDF document. Call read_page_content to extract its text.]";
        ctx.length = 0;
        return ctx;
      }

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
    //  Page Modification Engine (full-replacement model, persisted per origin)
    // ═══════════════════════════════════════════════════════════════════
    //
    //  Each origin has a single CSS snapshot stored in chrome.storage.local
    //  under key `pi_page_css` as { [origin]: { css, applied, updatedAt } }.
    //  The DOM holds exactly one <style id="pi-page-css"> reflecting that
    //  snapshot. All CSS-producing tools (modify_page_css, toggle_dark_mode,
    //  highlight_elements, remove_elements) update this single snapshot.

    const PAGE_CSS_KEY = "local:pi_page_css";
    const STYLE_TAG_ID = "pi-page-css";
    const DARK_RULES = `\nhtml { filter: invert(1) hue-rotate(180deg); background: #fff; }\nimg, video, canvas, svg, [style*="background-image"] { filter: invert(1) hue-rotate(180deg); }\n`;
    const DARK_MARKER = "/* pi-dark-mode */";

    /** Read the per-origin CSS snapshot from storage. */
    async function readOriginMods(): Promise<{ css: string; applied: boolean } | null> {
      try {
        const all = await chrome.storage.local.get(PAGE_CSS_KEY);
        const map = all[PAGE_CSS_KEY] || {};
        return map[location.origin] ?? null;
      } catch {
        return null;
      }
    }

    /** Write the per-origin CSS snapshot to storage and report new status. */
    async function writeOriginMods(css: string, applied: boolean): Promise<void> {
      try {
        const all = await chrome.storage.local.get(PAGE_CSS_KEY);
        const map = all[PAGE_CSS_KEY] || {};
        map[location.origin] = { css, applied, updatedAt: Date.now() };
        await chrome.storage.local.set({ [PAGE_CSS_KEY]: map });
      } catch { /* ignore quota errors */ }
      reportPageModsStatus();
    }

    /** Remove this origin's snapshot from storage. */
    async function clearOriginMods(): Promise<void> {
      try {
        const all = await chrome.storage.local.get(PAGE_CSS_KEY);
        const map = all[PAGE_CSS_KEY] || {};
        delete map[location.origin];
        await chrome.storage.local.set({ [PAGE_CSS_KEY]: map });
      } catch { /* ignore */ }
      reportPageModsStatus();
    }

    /** Ensure the single <style id="pi-page-css"> exists with the given CSS. */
    function applyCssToDom(css: string): void {
      let style = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_TAG_ID;
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = css;
    }

    /** Remove the page CSS style tag from the DOM. */
    function removeCssFromDom(): void {
      document.getElementById(STYLE_TAG_ID)?.remove();
    }

    /**
     * Append a CSS fragment to the current snapshot and persist.
     * The full-replacement model: there is only ever one snapshot per origin.
     */
    async function appendCss(fragment: string): Promise<void> {
      const current = await readOriginMods();
      const existing = current?.css ?? "";
      const next = existing ? `${existing.trimEnd()}\n${fragment}\n` : `${fragment}\n`;
      applyCssToDom(next);
      await writeOriginMods(next, true);
    }

    /** Report the current origin's mod status to the background (for UI). */
    function reportPageModsStatus(): void {
      readOriginMods().then((mods) => {
        chrome.runtime.sendMessage({
          type: "page_mods_status",
          origin: location.origin,
          count: mods?.css?.trim() ? 1 : 0,
          applied: mods?.applied ?? false,
          css: mods?.css ?? "",
        }).catch(() => {});
      }).catch(() => {});
    }

    /** Restore persisted CSS on page load. */
    async function restoreMods(): Promise<void> {
      const mods = await readOriginMods();
      if (mods?.css?.trim() && mods.applied) {
        applyCssToDom(mods.css);
      }
      reportPageModsStatus();
    }
    restoreMods();

    // Legacy in-memory mods for non-CSS tools (modify_page_style, etc.)
    interface Mod {
      id: string;
      revert(): void;
    }
    const mods: Mod[] = [];

    /** Whitelisted computed-style properties returned by read_element_styles. */
    const STYLE_WHITELIST = [
      // box model
      "display", "position", "top", "right", "bottom", "left", "z-index",
      "width", "height", "min-width", "max-width", "min-height", "max-height",
      "padding", "margin",
      "border", "border-width", "border-color", "border-style", "border-radius",
      // flex / grid
      "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self",
      "flex-grow", "flex-shrink", "flex-basis", "gap",
      "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
      // typography
      "font-family", "font-size", "font-weight", "font-style", "line-height",
      "letter-spacing", "text-align", "text-decoration", "text-transform", "white-space",
      // color / background
      "color", "background", "background-color", "background-image",
      // effects
      "opacity", "box-shadow", "overflow", "cursor", "transform", "transition",
    ];

    /** Collect `--*` custom properties in scope on an element (design tokens). */
    function collectCssVars(el: Element, cap: number): string[] {
      const cs = getComputedStyle(el);
      const out: string[] = [];
      for (let i = 0; i < cs.length && out.length < cap; i++) {
        const p = cs.item(i);
        if (!p.startsWith("--")) continue;
        const v = cs.getPropertyValue(p).trim();
        if (v) out.push(`${p}: ${v}`);
      }
      return out;
    }

    /** Detect whether the current page is a PDF rendered by Chrome's built-in viewer.
     *  Chrome loads the URL as-is but renders it via PDFium, so the DOM has no
     *  article text — we must fetch the raw bytes and let the bridge parse them. */
    function isPdfPage(): boolean {
      if (document.contentType === "application/pdf") return true;
      // Fallbacks: some embed/object layouts also indicate PDF.
      const embed = document.querySelector("embed[type='application/pdf'], object[type='application/pdf']");
      return !!embed;
    }

    /** Fetch the current PDF as base64 (same-origin, so cookies/auth travel). */
    async function fetchPdfAsBase64(): Promise<string> {
      const resp = await fetch(location.href, { credentials: "include" });
      if (!resp.ok) {
        throw new Error(`PDF fetch failed: ${resp.status} ${resp.statusText}`);
      }
      const blob = await resp.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
        reader.readAsDataURL(blob);
      });
    }

    async function execTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
      try {
        switch (toolName) {
          case "read_page_content": {
            // PDF pages have no DOM text — fetch raw bytes and let the bridge
            // extract via clawpdf (text + image fallback for scanned docs).
            if (isPdfPage()) {
              try {
                const base64 = await fetchPdfAsBase64();
                return { text: `PI_PDF_V1::${base64}` };
              } catch (err) {
                return { text: `❌ Failed to fetch PDF: ${(err as Error).message}`, isError: true };
              }
            }
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
            // Full-replacement model: append to the single persisted snapshot.
            await appendCss(args.css as string);
            return { text: "✅ CSS applied (saved for this site)" };
          }

          case "read_current_css": {
            // Returns ONLY pi's own injected snapshot (NOT the site's CSS).
            const mods = await readOriginMods();
            if (!mods?.css?.trim()) {
              return { text: "(pi has injected no CSS for this site yet)" };
            }
            return { text: `# pi's injected CSS for ${location.origin}\n\n\`\`\`css\n${mods.css}\n\`\`\`` };
          }

          case "read_element_styles": {
            const selector = (args.selector as string)?.trim();
            if (!selector) {
              return { text: "❌ selector is required", isError: true };
            }
            const el = document.querySelector<HTMLElement>(selector);
            if (!el) {
              return { text: `❌ No element matches \"${selector}\"`, isError: true };
            }
            const cs = getComputedStyle(el);
            const cls = el.getAttribute("class");
            const lines: string[] = [];
            lines.push(`# Element: <${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls.split(/\\s+/).join(".") : ""}>`);
            const inline = el.getAttribute("style");
            if (inline) lines.push(`Inline style: ${inline}`);
            lines.push("");
            lines.push("## Computed styles:");
            for (const prop of STYLE_WHITELIST) {
              const v = cs.getPropertyValue(prop);
              if (v) lines.push(`${prop}: ${v}`);
            }
            // CSS variables in scope on this element
            const vars = collectCssVars(el, 50);
            if (vars.length) {
              lines.push("");
              lines.push(`## CSS variables in scope (${vars.length}${vars.length === 50 ? "+" : ""}):`);
              lines.push(...vars);
            }
            // :root design tokens (always useful as the site's design system)
            const rootVars = collectCssVars(document.documentElement, 30);
            if (rootVars.length) {
              lines.push("");
              lines.push(`## :root design tokens (${rootVars.length}${rootVars.length === 30 ? "+" : ""}):`);
              lines.push(...rootVars);
            }
            return { text: lines.join("\n") };
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
            const current = await readOriginMods();
            const css = current?.css ?? "";
            const hasDark = css.includes(DARK_MARKER);
            const shouldTurnOn = enable === true || (enable === undefined && !hasDark);
            if (shouldTurnOn && !hasDark) {
              await appendCss(`${DARK_MARKER}${DARK_RULES}`);
              return { text: "🌙 Dark mode on" };
            }
            if (!shouldTurnOn && hasDark) {
              const next = css.split(DARK_MARKER)[0].trimEnd();
              if (next.trim()) {
                applyCssToDom(next);
                await writeOriginMods(next, true);
              } else {
                removeCssFromDom();
                await clearOriginMods();
              }
              return { text: "☀️ Dark mode off" };
            }
            return { text: hasDark ? "🌙 Dark mode already on" : "☀️ Dark mode already off" };
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
            await appendCss(css);
            return { text: `✅ Highlighted ${selectors.length} set(s)` };
          }

          case "remove_elements": {
            const selectors = args.selectors as string[];
            const css = selectors.map((s) => `${s} { display: none !important; }`).join("\n");
            await appendCss(css);
            return { text: `✅ Hidden ${selectors.length} set(s)` };
          }

          case "revert_page_modifications": {
            // Full-replacement model: clear the entire per-origin snapshot.
            const current = await readOriginMods();
            if (!current?.css?.trim()) {
              return { text: "ℹ️ No saved CSS to revert" };
            }
            removeCssFromDom();
            await clearOriginMods();
            return { text: "↩️ Reverted all CSS for this site" };
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
      // Return true to keep the channel open for async cases below.
      (async () => {
      try {
        switch (msg.type) {
          case "get_page_context":
            sendResponse({ pageContext: getPageContext() });
            break;

          case "get_page_mods_status": {
            const mods = await readOriginMods();
            sendResponse({
              origin: location.origin,
              count: mods?.css?.trim() ? 1 : 0,
              applied: mods?.applied ?? false,
              css: mods?.css ?? "",
            });
            break;
          }

          case "toggle_page_mods": {
            let action = msg.action as "on" | "off" | "toggle";
            const mods = await readOriginMods();
            if (!mods?.css?.trim()) {
              sendResponse({ ok: false, reason: "no CSS saved" });
              break;
            }
            if (action === "toggle") action = mods.applied ? "off" : "on";
            if (action === "off") {
              removeCssFromDom();
              await writeOriginMods(mods.css, false);
            } else {
              applyCssToDom(mods.css);
              await writeOriginMods(mods.css, true);
            }
            sendResponse({ ok: true });
            break;
          }

          case "revert_page_mods": {
            removeCssFromDom();
            await clearOriginMods();
            sendResponse({ ok: true });
            break;
          }

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
            const result = await execTool(msg.toolName, msg.args);
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
      })();
      return true; // async response
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
