import { describe, it, expect, vi } from "vitest";

const mockPage = {
  goto: vi.fn(async () => {}),
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
import { capturePageScreenshot } from "../src/pageScreenshot";
import type { Env } from "../src/index";

function makeEnv(): Env {
  return { BROWSER: {} } as unknown as Env;
}

describe("capturePageScreenshot", () => {
  it("launches the browser, navigates to the PDF page, and returns the screenshot bytes", async () => {
    mockPage.goto.mockClear();
    mockPage.screenshot.mockClear();
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(pdfBytes, 3, makeEnv());

    expect(result).not.toBeNull();
    expect(new Uint8Array(result as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(mockPage.goto).toHaveBeenCalledTimes(1);
    const [url] = mockPage.goto.mock.calls[0];
    expect(url).toContain("data:application/pdf;base64,");
    expect(url).toContain("#page=3");
  });

  it("returns null (never throws) when the browser launch fails", async () => {
    vi.mocked(puppeteer.launch).mockRejectedValueOnce(new Error("no browser sessions available"));
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(pdfBytes, 1, makeEnv());

    expect(result).toBeNull();
  });

  it("returns null (never throws) when navigation or screenshot fails", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("navigation timeout"));
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(pdfBytes, 1, makeEnv());

    expect(result).toBeNull();
  });
});
