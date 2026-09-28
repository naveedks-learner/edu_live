import { describe, it, expect } from "vitest";
import { withCors, handleCorsPreflight } from "../src/cors";

describe("withCors", () => {
  it("adds CORS headers to a response", () => {
    const response = withCors(Response.json({ ok: true }));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("preserves the original status and body", async () => {
    const response = withCors(Response.json({ error: "bad" }, { status: 400 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad" });
  });
});

describe("handleCorsPreflight", () => {
  it("returns a 204 with CORS headers for an OPTIONS request", () => {
    const response = handleCorsPreflight();

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
