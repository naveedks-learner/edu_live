import type { Env } from "./index";

// This route is public (no admin auth) so the frontend can load images
// directly as <img src>. Restricting it to the page-images/ prefix (and
// requiring .png) stops it from being used to download the source PDFs
// stored in the same bucket under their own filenames.
function isServableImageKey(key: string): boolean {
  return key.startsWith("page-images/") && key.endsWith(".png") && !key.includes("..");
}

export async function handleGetImage(key: string, env: Env): Promise<Response> {
  if (!isServableImageKey(key)) {
    return new Response("Not found", { status: 404 });
  }
  const object = await env.PDF_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(await object.arrayBuffer(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}
