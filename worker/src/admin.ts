import type { Env } from "./index";

export function isAdminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) return true;
  return request.headers.get("x-admin-key") === env.ADMIN_API_KEY;
}

function adminErrorResponse(routeName: string, err: unknown): Response {
  console.error(`${routeName} failed`, err);
  return Response.json({ error: "Something went wrong loading this data - please try again." }, { status: 500 });
}

export async function handleAdminDocuments(env: Env): Promise<Response> {
  try {
    const listed = await env.PDF_BUCKET.list({ include: ["customMetadata"] });

    const documents = listed.objects.map((obj) => ({
      name: obj.key,
      sizeBytes: obj.size,
      indexedAt: obj.customMetadata?.indexedAt ?? null,
      chunkCount: obj.customMetadata?.chunkCount ? Number(obj.customMetadata.chunkCount) : null,
      pageCount: obj.customMetadata?.pageCount ? Number(obj.customMetadata.pageCount) : null,
    }));

    return Response.json({ documents });
  } catch (err) {
    return adminErrorResponse("/admin/documents", err);
  }
}

export async function handleAdminTransactions(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10) : 3;

    const result = await env.EDU_LIVE_DB.prepare("SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?")
      .bind(limit)
      .all<Record<string, unknown>>();

    const transactions = result.results.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      question: row.question,
      provider: row.provider,
      model: row.model,
      pathTaken: row.path_taken,
      confidence: row.confidence,
      retrieval: JSON.parse(row.retrieval_json as string),
      llmInput: row.llm_input,
      llmOutput: row.llm_output,
      jevInput: row.jev_input_json ? JSON.parse(row.jev_input_json as string) : null,
      jevOutput: row.jev_output_json ? JSON.parse(row.jev_output_json as string) : null,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      jevCostUsd: row.jev_cost_usd,
      llmCostUsd: row.llm_cost_usd,
    }));

    return Response.json({ transactions });
  } catch (err) {
    return adminErrorResponse("/admin/transactions", err);
  }
}

const RANGE_TO_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export async function handleAdminCosting(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const requestedRange = url.searchParams.get("range") ?? "1d";
    const range = RANGE_TO_MS[requestedRange] ? requestedRange : "1d";
    const since = new Date(Date.now() - RANGE_TO_MS[range]).toISOString();

    const lastTransaction = await env.EDU_LIVE_DB.prepare(
      "SELECT input_tokens, output_tokens, jev_cost_usd, llm_cost_usd, timestamp FROM transactions ORDER BY timestamp DESC LIMIT 1"
    )
      .bind()
      .first();

    const summary = await env.EDU_LIVE_DB.prepare(
      `SELECT COUNT(*) as queryCount,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(jev_cost_usd), 0) as jevCostUsd,
              COALESCE(SUM(llm_cost_usd), 0) as llmCostUsd
       FROM transactions WHERE timestamp > ?`
    )
      .bind(since)
      .first();

    return Response.json({ range, lastTransaction: lastTransaction ?? null, summary });
  } catch (err) {
    return adminErrorResponse("/admin/costing", err);
  }
}
