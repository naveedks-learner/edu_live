/**
 * The frontend (Pages) and the Worker are different origins, so every
 * response needs CORS headers and OPTIONS preflight requests need an
 * explicit answer - without this a browser silently blocks every request
 * (confirmed live during final review: the deployed frontend could not
 * reach the deployed Worker at all).
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function handleCorsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
