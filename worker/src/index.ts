import { handleIngest } from "./ingestion";
import { handleChat } from "./chat";
import { withCors, handleCorsPreflight } from "./cors";

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  PDF_BUCKET: R2Bucket;
  GUARDRAIL_ENABLED: string;
  JEV_ENABLED: string;
  // JEV runs via OpenRouter's typed-decision API (model "~typesafe/jev-latest"),
  // so it's authenticated with an OpenRouter key, not a separate JEV-specific one.
  OPENROUTER_API_KEY: string;
  // Shared secret required on the x-ingest-key header for POST /ingest.
  // Optional: if unset, /ingest is unauthenticated (e.g. local dev).
  INGEST_API_KEY: string;
  EDU_LIVE_DB: D1Database;
  // Shared secret required on the x-admin-key header for the /admin/* routes.
  // Optional: if unset, /admin/* is unauthenticated (e.g. local dev).
  ADMIN_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleCorsPreflight();
    }
    if (request.method === "POST" && url.pathname === "/ingest") {
      return withCors(await handleIngest(request, env));
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      return withCors(await handleChat(request, env, ctx));
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
};
