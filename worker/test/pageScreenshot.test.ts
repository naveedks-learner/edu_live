import { describe, it, expect, vi } from "vitest";

const mockPage = {
  setViewport: vi.fn(async (_opts: unknown) => {}),
  goto: vi.fn(async (_url: string, _opts?: unknown) => {}),
  screenshot: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  close: vi.fn(async () => {}),
};
const mockBrowser = {
  newPage: vi.fn(async () => mockPage),
  close: vi.fn(async () => {}),
};

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn(async () => mockBrowser) },
}));

import puppeteer from "@cloudflare/puppeteer";
import { capturePageScreenshot, launchScreenshotBrowser } from "../src/pageScreenshot";
import type { Env } from "../src/index";

function makeEnv(): Env {
  return { BROWSER: {} } as unknown as Env;
}

describe("launchScreenshotBrowser", () => {
  it("launches and returns a browser instance", async () => {
    const browser = await launchScreenshotBrowser(makeEnv());
    expect(browser).not.toBeNull();
  });

  it("returns null (never throws) when launch fails", async () => {
    vi.mocked(puppeteer.launch).mockRejectedValueOnce(new Error("no browser sessions available"));
    const browser = await launchScreenshotBrowser(makeEnv());
    expect(browser).toBeNull();
  });
});

describe("capturePageScreenshot", () => {
  it("opens a page on the given browser, navigates to the PDF page, and returns the screenshot bytes, closing only the page (not the browser)", async () => {
    mockPage.goto.mockClear();
    mockPage.screenshot.mockClear();
    mockPage.close.mockClear();
    mockBrowser.close.mockClear();
    const browser = (await launchScreenshotBrowser(makeEnv()))!;
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(browser, pdfBytes, 3);

    expect(result).not.toBeNull();
    expect(new Uint8Array(result as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(mockPage.goto).toHaveBeenCalledTimes(1);
    const [url] = mockPage.goto.mock.calls[0];
    expect(url).toContain("data:application/pdf;base64,");
    expect(url).toContain("#page=3");
    expect(mockPage.close).toHaveBeenCalledTimes(1);
    expect(mockBrowser.close).not.toHaveBeenCalled();
  });

  it("disables Chromium's PDF viewer toolbar and thumbnail sidebar in the URL, so the screenshot captures only the page content, not the viewer UI chrome", async () => {
    mockPage.goto.mockClear();
    const browser = (await launchScreenshotBrowser(makeEnv()))!;
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    await capturePageScreenshot(browser, pdfBytes, 1);

    const [url] = mockPage.goto.mock.calls[0];
    expect(url).toContain("toolbar=0");
    expect(url).toContain("navpanes=0");
    expect(url).toContain("statusbar=0");
  });

  it("sets a larger viewport before navigating, so more of the page is captured than Puppeteer's small default", async () => {
    mockPage.setViewport.mockClear();
    const browser = (await launchScreenshotBrowser(makeEnv()))!;
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    await capturePageScreenshot(browser, pdfBytes, 1);

    expect(mockPage.setViewport).toHaveBeenCalledWith(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
    const [{ width, height }] = mockPage.setViewport.mock.calls[0] as [{ width: number; height: number }];
    expect(width).toBeGreaterThanOrEqual(1200);
    expect(height).toBeGreaterThanOrEqual(1200);
  });

  it("returns null (never throws) when navigation or screenshot fails", async () => {
    const browser = (await launchScreenshotBrowser(makeEnv()))!;
    mockPage.goto.mockRejectedValueOnce(new Error("navigation timeout"));
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(browser, pdfBytes, 1);

    expect(result).toBeNull();
  });

  it("can be called multiple times on the same browser instance (one browser reused across figure pages)", async () => {
    const browser = (await launchScreenshotBrowser(makeEnv()))!;
    mockBrowser.newPage.mockClear();
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    await capturePageScreenshot(browser, pdfBytes, 1);
    await capturePageScreenshot(browser, pdfBytes, 2);

    expect(vi.mocked(puppeteer.launch)).not.toHaveBeenCalledTimes(0); // launched once via launchScreenshotBrowser above
    expect(mockBrowser.newPage).toHaveBeenCalledTimes(2);
  });
});
