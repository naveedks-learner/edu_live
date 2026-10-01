import { handleIngest } from "./ingestion";
import { handleChat } from "./chat";
import { handleExplain } from "./explain";
import { handleGetImage } from "./images";
import { withCors, handleCorsPreflight } from "./cors";
import {
  isAdminAuthorized,
  handleAdminDocuments,
  handleAdminTransactions,
  handleAdminCosting,
  handleAdminGetConfig,
  handleAdminPutConfig,
  handleAdminGetCleanedDocument,
} from "./admin";

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
  // Cloudflare Browser Rendering - used to screenshot PDF pages containing
  // figures, so the actual image (not just a text description) can be
  // shown back to students. See worker/src/pageScreenshot.ts.
  BROWSER: Fetcher;
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
    if (request.method === "POST" && url.pathname === "/explain") {
      return withCors(await handleExplain(request, env, ctx));
    }
    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      const key = decodeURIComponent(url.pathname.slice("/images/".length));
      return withCors(await handleGetImage(key, env));
    }
    if (request.method === "GET" && url.pathname === "/admin/documents") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminDocuments(env));
    }
    if (request.method === "GET" && url.pathname === "/admin/documents/cleaned") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminGetCleanedDocument(request, env));
    }
    if (request.method === "GET" && url.pathname === "/admin/transactions") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminTransactions(request, env));
    }
    if (request.method === "GET" && url.pathname === "/admin/costing") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminCosting(request, env));
    }
    if (request.method === "GET" && url.pathname === "/admin/config") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminGetConfig(env));
    }
    if (request.method === "PUT" && url.pathname === "/admin/config") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminPutConfig(request, env));
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
};
