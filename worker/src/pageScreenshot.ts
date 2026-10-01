import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import type { Env } from "./index";

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Launches one Browser Rendering session to be reused across every figure
 * page in a single ingest (capturePageScreenshot opens/closes a page per
 * call, not a browser per call) - Browser Rendering caps launches per
 * minute more tightly than plain fetch concurrency, so launching once per
 * document instead of once per figure page matters for any multi-figure
 * PDF. Never throws: returns null on failure so ingestion can skip
 * screenshot capture entirely rather than fail.
 */
export async function launchScreenshotBrowser(env: Env): Promise<Browser | null> {
  try {
    return await puppeteer.launch(env.BROWSER);
  } catch (err) {
    console.error("browser rendering launch failed", err);
    return null;
  }
}

/**
 * Screenshots one page of a PDF on an already-launched browser, using
 * Cloudflare Browser Rendering - Chromium's built-in PDF viewer renders the
 * page (including any embedded image, even one nested inside a table cell)
 * exactly as laid out, so we never have to solve PDF rasterization
 * ourselves. Never throws: any failure (navigation timeout, screenshot
 * error) returns null, since a failed screenshot must not block ingestion -
 * the page's Markdown-enriched text (with its [Figure: ...] description) is
 * still indexed either way. Only the page is closed here, not the browser -
 * the caller (which launched it via launchScreenshotBrowser) owns closing
 * the browser once after all figure pages are done.
 */
export async function capturePageScreenshot(
  browser: Browser,
  pdfBytes: ArrayBuffer,
  pageNumber: number
): Promise<ArrayBuffer | null> {
  let page;
  try {
    page = await browser.newPage();
    // Puppeteer's default viewport (800x600) is small enough that Chromium's
    // PDF viewer UI chrome (toolbar, thumbnail sidebar) ends up taking a
    // large share of the captured frame alongside the actual page content -
    // confirmed in production: a captured screenshot showed the full browser
    // PDF-viewer app, not a clean page image. A larger viewport leaves more
    // room for the actual content relative to that chrome.
    await page.setViewport({ width: 1600, height: 1600 });
    // toolbar=0/navpanes=0/statusbar=0 are Chromium PDF viewer URL
    // parameters that hide its toolbar and thumbnail sidebar - without them
    // the screenshot captures the browser's PDF-reader app, not the page.
    const dataUrl = `data:application/pdf;base64,${base64FromArrayBuffer(pdfBytes)}#page=${pageNumber}&toolbar=0&navpanes=0&statusbar=0`;
    // networkidle0 (rather than the default "load") waits for the PDF
    // viewer's own rendering to settle before screenshotting - screenshotting
    // immediately on "load" can capture a blank or toolbar-only frame.
    await page.goto(dataUrl, { waitUntil: "networkidle0" });
    const screenshot = await page.screenshot();
    return screenshot as unknown as ArrayBuffer;
  } catch (err) {
    console.error(`page screenshot failed for page ${pageNumber}`, err);
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}
