import { describe, it, expect } from "vitest";
import { handleGetImage } from "../src/images";
import type { Env } from "../src/index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PDF_BUCKET: {
      get: async () => null,
    },
    ...overrides,
  } as unknown as Env;
}

describe("handleGetImage", () => {
  it("returns the PNG bytes with an image/png content type when the key exists", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]).buffer;
    const env = makeEnv({
      PDF_BUCKET: {
        get: async (key: string) => {
          expect(key).toBe("page-images/notes.pdf/3.png");
          return { arrayBuffer: async () => pngBytes } as unknown as R2ObjectBody;
        },
      } as unknown as R2Bucket,
    });

    const response = await handleGetImage("page-images/notes.pdf/3.png", env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(pngBytes));
  });

  it("returns 404 when the key doesn't exist", async () => {
    const env = makeEnv({ PDF_BUCKET: { get: async () => null } as unknown as R2Bucket });
    const response = await handleGetImage("page-images/missing.pdf/1.png", env);
    expect(response.status).toBe(404);
  });
});
