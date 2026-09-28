import { handleIngest } from "./ingestion";
import { handleChat } from "./chat";

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  PDF_BUCKET: R2Bucket;
  GUARDRAIL_ENABLED: string;
  JEV_ENABLED: string;
  // JEV runs via OpenRouter's typed-decision API (model "~typesafe/jev-latest"),
  // so it's authenticated with an OpenRouter key, not a separate JEV-specific one.
  OPENROUTER_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      return handleChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
