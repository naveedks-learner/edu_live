import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Screenshots one page of a PDF using Cloudflare Browser Rendering -
 * Chromium's built-in PDF viewer renders the page (including any embedded
 * image, even one nested inside a table cell) exactly as laid out, so we
 * never have to solve PDF rasterization ourselves. Never throws: any
 * failure (no browser session available, navigation timeout, screenshot
 * error) returns null, since a failed screenshot must not block ingestion -
 * the page's Markdown-enriched text (with its [Figure: ...] description) is
 * still indexed either way.
 */
export async function capturePageScreenshot(
  pdfBytes: ArrayBuffer,
  pageNumber: number,
  env: Env
): Promise<ArrayBuffer | null> {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    const dataUrl = `data:application/pdf;base64,${base64FromArrayBuffer(pdfBytes)}#page=${pageNumber}`;
    await page.goto(dataUrl);
    const screenshot = await page.screenshot();
    return screenshot as ArrayBuffer;
  } catch (err) {
    console.error(`page screenshot failed for page ${pageNumber}`, err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
