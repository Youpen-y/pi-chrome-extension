/**
 * PDF extraction via clawpdf (PDFium WASM).
 *
 * Used when read_page_content encounters a PDF page: the extension fetches the
 * PDF bytes (same-origin, so cookies/auth just work) and forwards them as
 * base64; the bridge then extracts text — and, if the PDF has little text
 * (scanned docs), falls back to rendering page images for the vision model.
 *
 * clawpdf's `extractPdf({ mode: "auto" })` does the text-first fallback
 * automatically: it extracts text and only renders PNGs when text is shorter
 * than `minTextChars`.
 */

import { extractPdf, type ExtractResult } from "clawpdf";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Max image pages sent to the model in one call (token budget protection). */
const MAX_IMAGE_PAGES = 5;
/** Default extraction limits. */
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_MAX_TEXT_CHARS = 50_000;
/** Render fallback threshold: fewer chars than this triggers image rendering. */
const MIN_TEXT_CHARS_FOR_FALLBACK = 200;

export interface PdfProcessResult {
  /** Extracted text (already truncated to maxTextChars by clawpdf). */
  text: string;
  /** Page images as LLM image content (empty for text PDFs). */
  images: ImageContent[];
  /** Number of pages processed. */
  pagesProcessed: number;
  /** Whether text or images were truncated. */
  truncated: { text: boolean; images: boolean };
}

/**
 * Extract text (and fallback images) from a PDF represented as raw bytes.
 *
 * Uses clawpdf's shared engine internally — the WASM is loaded once per process.
 */
export async function processPdfBytes(
  bytes: Uint8Array,
  options: { password?: string; maxPages?: number } = {},
): Promise<PdfProcessResult> {
  const result: ExtractResult = await extractPdf(bytes, {
    mode: "auto",
    password: options.password,
    maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
    maxTextChars: DEFAULT_MAX_TEXT_CHARS,
    minTextChars: MIN_TEXT_CHARS_FOR_FALLBACK,
    image: { dpi: 96, maxPixels: 4_000_000, forms: true },
  });

  // Cap image count to protect token budget; clawpdf already marks truncation.
  const capped = result.images.slice(0, MAX_IMAGE_PAGES);
  const imagesTruncated = result.images.length > capped.length || result.truncated.images;

  const images: ImageContent[] = capped.map((img) => ({
    type: "image",
    data: Buffer.from(img.bytes).toString("base64"),
    mimeType: "image/png",
  }));

  return {
    text: result.text,
    images,
    pagesProcessed: result.pagesProcessed.length,
    truncated: { text: result.truncated.text, images: imagesTruncated },
  };
}

/**
 * Decode a base64 string (as forwarded by the extension) into PDF bytes.
 * Node's Buffer handles both pure base64 and data: URLs.
 */
export function base64ToPdfBytes(base64: string): Uint8Array {
  const stripped = base64.startsWith("data:") ? base64.split(",")[1] ?? "" : base64;
  return Uint8Array.from(Buffer.from(stripped, "base64"));
}

/** Build the text summary shown to the model alongside (or instead of) images. */
export function buildPdfSummary(result: PdfProcessResult, source: string): string {
  const parts: string[] = [];
  parts.push(`# PDF extracted from ${source}`);
  parts.push(`Pages processed: ${result.pagesProcessed}`);
  if (result.images.length > 0) {
    parts.push(
      `Text layer was thin (${result.text.length} chars) — ${result.images.length} page image(s) rendered for vision.`,
    );
  }
  if (result.truncated.text || result.truncated.images) {
    parts.push("⚠️ Output truncated to fit context; ask the user for specific pages if needed.");
  }
  parts.push("");
  if (result.text.trim()) {
    parts.push("## Extracted text");
    parts.push(result.text);
  } else {
    parts.push("_(No extractable text — PDF is likely scanned. See rendered page images.)_");
  }
  return parts.join("\n");
}
