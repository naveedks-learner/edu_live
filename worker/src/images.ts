import type { Env } from "./index";

export async function handleGetImage(key: string, env: Env): Promise<Response> {
  const object = await env.PDF_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(await object.arrayBuffer(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}
