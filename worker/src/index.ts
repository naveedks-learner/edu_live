export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  PDF_BUCKET: R2Bucket;
  GUARDRAIL_ENABLED: string;
  JEV_ENABLED: string;
  JEV_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response("edu-live worker: not yet implemented", { status: 501 });
  },
};
