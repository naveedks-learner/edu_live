# Cloudflare RAG Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python/Streamlit/ChromaDB RAG app in `edu_live` with a working Cloudflare-native equivalent (Worker API + Pages frontend + Vectorize + Workers AI + R2), provable end-to-end by uploading a PDF and then chatting about it.

**Architecture:** A Cloudflare Worker exposes `POST /ingest` (R2 store → PDF text extraction → chunk → embed → Vectorize upsert) and `POST /chat` (guardrail → retrieve → rerank → JEV filter → web fallback → generate). A static Cloudflare Pages site provides the upload/chat UI. Fixed pipeline, no agentic tool-calling loop (deferred — see spec).

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Vitest, Workers AI (`@cf/baai/bge-base-en-v1.5` embeddings, `@cf/meta/llama-3.1-8b-instruct` generation, Workers AI reranker model), Vectorize, R2, `unpdf` for PDF text extraction, JEV HTTP API, DuckDuckGo (via `ddgs`-equivalent HTTP fetch, no API key).

**Spec:** `docs/superpowers/specs/2026-09-28-cloudflare-rag-migration-design.md`

## Global Constraints

- Runtime: Cloudflare Workers, TypeScript, `compatibility_flags = ["nodejs_compat"]`.
- Embedding model for ingestion, guardrail, and retrieval must be the same model: `@cf/baai/bge-base-en-v1.5` (vectors must be comparable).
- Generation model: `@cf/meta/llama-3.1-8b-instruct`.
- No multi-turn agentic tool-calling loop — fixed pipeline only (retrieve → rerank → JEV filter → web fallback → generate).
- No full observability dashboard — `console.log`/`wrangler tail` only for this pass.
- `GUARDRAIL_ENABLED` and `JEV_ENABLED` env vars, both default `"true"`.
- Guardrail fails **closed** on internal errors (e.g. embedding call throws): block with a distinct `"guardrail_error"` reason/message, never silently indistinguishable from an actual policy block.
- Every binding-dependent stage (rerank, JEV, web search) must degrade gracefully on failure — log and continue with the next-best data, never throw the whole request into a 500 for an optional stage.
- Secrets (`JEV_API_KEY`) set via `wrangler secret put`, never committed to the repo.
- Deploy shape: separate Worker (API) and Pages (static frontend) projects, per user's explicit choice.
- Old Python app (`src/`, `tests/`, `requirements.txt`, `chroma_db/`) is removed from this repo as part of this work; it remains available, untouched, in `edukripa_edutech`.

## Review Focus

- Empty PDF upload / non-PDF file to `POST /ingest` → should return a clear 400, not crash the Worker or write garbage to R2/Vectorize.
- Uploading the same filename twice → should skip re-indexing (mirrors the Python app's per-source skip), not create duplicate vectors.
- `POST /chat` when the Vectorize index has zero chunks (nothing ingested yet) → should degrade to the web-search fallback or return a clear "no documents indexed yet" answer, not crash on an empty retrieval result.
- Guardrail keyword blocklist false-positiving on legitimate curriculum content (e.g. "sexual reproduction in plants", "drug interactions in the human body" are real biology topics) → the ported blocklist must use specific phrases, not bare words like "sex" or "drugs" that appear in normal science vocabulary.
- JEV and the reranker both unreachable at the same time, while Vectorize retrieval itself succeeds → the chat pipeline must still produce an answer from cosine-ranked chunks, not fail the whole request because two optional stages are down.

---

## File Structure

```
worker/
  src/
    index.ts          # fetch handler / router: POST /ingest, POST /chat
    types.ts           # shared interfaces (Chunk, GuardrailDecision, etc.)
    chunker.ts          # pure chunking algorithm (ported chunker.py)
    guardrail.ts          # pure decision logic + keyword check (ported query_scope_and_age_guardrail.py)
    guardrailCheck.ts       # Workers-AI-backed wiring: embeds question, calls guardrail.ts, fail-closed
    rerank.ts                # rerank + cosine-order fallback, injectable scorer for testing
    jev.ts                     # JEV HTTP client + pure threshold filter
    webSearch.ts                 # DuckDuckGo fetch client, pure result formatter
    pdf.ts                         # PDF text extraction (unpdf wrapper)
    ingestion.ts                    # POST /ingest handler: R2 + pdf.ts + chunker.ts + Vectorize upsert
    chat.ts                          # POST /chat handler: full pipeline wiring
  test/
    chunker.test.ts
    guardrail.test.ts
    rerank.test.ts
    jev.test.ts
  wrangler.toml
  package.json
  tsconfig.json
frontend/
  index.html          # upload + chat UI, no framework
  app.js                # fetch calls to the Worker
  style.css
```

---

### Task 1: Remove Python app, scaffold Worker and Pages projects

**Files:**
- Delete: `src/` (entire Python package), `tests/` (entire Python test tree), `requirements.txt`, `runtime.txt`, `test_runner.py`, `chroma_db/` (if present), `.streamlit/`, `.devcontainer/` (Python-specific)
- Modify: `data/` — keep the PDFs (`data/*.pdf`) as manual smoke-test fixtures for Task 11, but move them to `worker/test-fixtures/` so they travel with the Worker project
- Create: `worker/package.json`, `worker/wrangler.toml`, `worker/tsconfig.json`, `worker/src/index.ts` (stub), `frontend/index.html` (stub)
- Modify: `README.md` — replace Python setup instructions with Cloudflare setup instructions
- Modify: `.gitignore` — add `worker/node_modules/`, `worker/.wrangler/`, `worker/dist/`

**Interfaces:**
- Produces: a working `wrangler dev` skeleton other tasks build into. No exported functions yet.

- [ ] **Step 1: Delete the Python app**

```bash
git rm -r src/ tests/ requirements.txt runtime.txt test_runner.py .streamlit/ .devcontainer/ 2>/dev/null
rm -rf chroma_db/ .pytest_cache/
mkdir -p worker/test-fixtures
git mv "data/light notes.pdf" worker/test-fixtures/light-notes.pdf
git mv "data/life Processes notes.pdf" worker/test-fixtures/life-processes-notes.pdf
git mv "data/carbon compound notes.pdf" worker/test-fixtures/carbon-compound-notes.pdf
rmdir data 2>/dev/null || true
```

- [ ] **Step 2: Scaffold the Worker project**

```bash
mkdir -p worker/src worker/test
cd worker
npm init -y
npm install --save-dev typescript wrangler vitest @cloudflare/workers-types
npm install unpdf
```

Create `worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

Create `worker/wrangler.toml`:

```toml
name = "edu-live-worker"
main = "src/index.ts"
compatibility_date = "2026-09-28"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "edu-live-chunks"

[[r2_buckets]]
binding = "PDF_BUCKET"
bucket_name = "edu-live-pdfs"

[vars]
GUARDRAIL_ENABLED = "true"
JEV_ENABLED = "true"
```

Create `worker/src/index.ts` (stub, replaced fully in Task 8/9):

```typescript
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
```

Add to `worker/package.json` `"scripts"`:

```json
{
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
```

- [ ] **Step 3: Scaffold the Pages frontend stub**

Create `frontend/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Edukripa</title></head>
<body><p>edu-live frontend: not yet implemented</p></body>
</html>
```

- [ ] **Step 4: Update .gitignore and README**

Append to `.gitignore`:

```
worker/node_modules/
worker/.wrangler/
worker/dist/
```

Replace `README.md` contents with a short placeholder (full rewrite happens once the pipeline works):

```markdown
# Edukripa RAG (Cloudflare)

Cloudflare-native RAG chatbot: Worker API (`worker/`) + Pages frontend (`frontend/`).
Setup and deploy instructions land in Task 11 of `docs/superpowers/plans/2026-09-28-cloudflare-rag-migration.md`.
```

- [ ] **Step 5: Verify the skeleton runs**

```bash
cd worker
npx wrangler dev --local
```

Expected: dev server starts without errors; `curl http://localhost:8787/` returns the 501 stub response.

- [ ] **Step 6: Commit**

```bash
cd ..
git add -A
git commit -m "Remove Python app, scaffold Cloudflare Worker + Pages skeleton"
```

---

### Task 2: Port the chunking algorithm

**Files:**
- Create: `worker/src/types.ts`
- Create: `worker/src/chunker.ts`
- Test: `worker/test/chunker.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface PageText { page: number; text: string; }
  interface Chunk {
    text: string; page: number; pageEnd: number; chunkId: number;
    source: string; wordStart: number; wordEnd: number;
    chunkSize: number; overlap: number;
  }
  function chunkText(pages: PageText[], source: string, chunkSize?: number, overlap?: number): Chunk[]
  ```

- [ ] **Step 1: Create shared types file**

`worker/src/types.ts`:

```typescript
export interface PageText {
  page: number;
  text: string;
}

export interface Chunk {
  text: string;
  page: number;
  pageEnd: number;
  chunkId: number;
  source: string;
  wordStart: number;
  wordEnd: number;
  chunkSize: number;
  overlap: number;
}
```

- [ ] **Step 2: Write the failing test**

`worker/test/chunker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { chunkText } from "../src/chunker";

describe("chunkText", () => {
  it("splits words across pages with overlap, continuous across page breaks", () => {
    const pages = [
      { page: 1, text: Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") },
      { page: 2, text: Array.from({ length: 300 }, (_, i) => `word${400 + i}`).join(" ") },
    ];

    const chunks = chunkText(pages, "fake.pdf", 300, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].wordStart).toBe(0);
    expect(chunks[0].wordEnd).toBe(300);
    expect(chunks[0].page).toBe(1);
    // second chunk starts at 300 - 50 = 250 (overlap re-included)
    expect(chunks[1].wordStart).toBe(250);
    // total words = 700, so this chunk straddles the page 1/2 boundary (word 400)
    expect(chunks[1].page).toBe(1);
    expect(chunks[1].pageEnd).toBe(2);
  });

  it("returns an empty array for pages with no extractable text", () => {
    expect(chunkText([{ page: 1, text: "" }], "empty.pdf")).toEqual([]);
  });

  it("throws when overlap is not smaller than chunkSize", () => {
    expect(() => chunkText([{ page: 1, text: "a b c" }], "x.pdf", 10, 10)).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd worker && npx vitest run test/chunker.test.ts
```

Expected: FAIL — `Cannot find module '../src/chunker'`.

- [ ] **Step 4: Implement chunkText**

`worker/src/chunker.ts`:

```typescript
import type { PageText, Chunk } from "./types";

/**
 * Splits extracted page text into overlapping word-count chunks. Direct
 * port of chunker.py's chunk_text: chunking flows across the whole
 * document (not restarted per page) so page boundaries don't produce
 * weak, small chunks.
 */
export function chunkText(
  pages: PageText[],
  source: string,
  chunkSize = 300,
  overlap = 50
): Chunk[] {
  if (overlap >= chunkSize) {
    throw new Error("overlap must be smaller than chunkSize");
  }

  const words: string[] = [];
  const wordPages: number[] = [];
  for (const page of pages) {
    const pageWords = page.text.split(/\s+/).filter(Boolean);
    words.push(...pageWords);
    wordPages.push(...new Array(pageWords.length).fill(page.page));
  }

  if (words.length === 0) {
    return [];
  }

  const chunks: Chunk[] = [];
  let chunkId = 0;
  let start = 0;

  while (start < words.length) {
    const end = start + chunkSize;
    const chunkWords = words.slice(start, end);
    const wordEnd = Math.min(end, words.length);

    chunks.push({
      text: chunkWords.join(" "),
      page: wordPages[start],
      pageEnd: wordPages[wordEnd - 1],
      chunkId,
      source,
      wordStart: start,
      wordEnd,
      chunkSize,
      overlap,
    });
    chunkId += 1;

    if (end >= words.length) break;
    start = end - overlap;
  }

  return chunks;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd worker && npx vitest run test/chunker.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/src/types.ts worker/src/chunker.ts worker/test/chunker.test.ts
git commit -m "Port chunking algorithm to TypeScript"
```

---

### Task 3: Guardrail pure decision logic + keyword check

**Files:**
- Create: `worker/src/guardrail.ts`
- Test: `worker/test/guardrail.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  ```typescript
  type GuardrailReason = "age_inappropriate" | "out_of_scope" | "guardrail_error" | null;
  interface GuardrailDecision { allowed: boolean; reason: GuardrailReason; refusalMessage: string | null; }
  const REFUSAL_AGE_INAPPROPRIATE: string;
  const REFUSAL_OUT_OF_SCOPE: string;
  const REFUSAL_GUARDRAIL_ERROR: string;
  const IN_SCOPE_EXAMPLE_QUESTIONS: string[];
  const OUT_OF_SCOPE_EXAMPLE_QUESTIONS: string[];
  function containsBlockedKeyword(question: string): boolean
  function decideGuardrailOutcome(
    keywordBlocked: boolean,
    inScopeSimilarity: number,
    outScopeSimilarity: number,
    minInScopeSimilarity?: number
  ): GuardrailDecision
  ```

This task fixes a real bug the Python version carried: the original `BLOCKED_KEYWORDS` list included bare words like `"drugs"` and `"sex"` that also appear in legitimate biology/chemistry vocabulary (e.g. "drug interactions", "sexual reproduction in plants"). The ported list uses specific phrases only.

- [ ] **Step 1: Write the failing tests**

`worker/test/guardrail.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { containsBlockedKeyword, decideGuardrailOutcome } from "../src/guardrail";

describe("containsBlockedKeyword", () => {
  it("flags a clear self-harm phrase", () => {
    expect(containsBlockedKeyword("how do I hurt myself")).toBe(true);
  });

  it("does not flag a biology question about drug interactions", () => {
    expect(containsBlockedKeyword("what are drug interactions in the human body")).toBe(false);
  });

  it("does not flag a biology question about sexual reproduction", () => {
    expect(containsBlockedKeyword("explain sexual reproduction in flowering plants")).toBe(false);
  });

  it("flags an explicit request to buy illegal drugs", () => {
    expect(containsBlockedKeyword("where can I buy illegal drugs")).toBe(true);
  });
});

describe("decideGuardrailOutcome", () => {
  it("blocks when a keyword hit occurs regardless of similarity", () => {
    const d = decideGuardrailOutcome(true, 0.9, 0.1, 0.35);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("age_inappropriate");
  });

  it("allows when in-scope similarity dominates", () => {
    const d = decideGuardrailOutcome(false, 0.72, 0.3, 0.35);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("blocks when out-of-scope similarity dominates", () => {
    const d = decideGuardrailOutcome(false, 0.4, 0.65, 0.35);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("out_of_scope");
  });

  it("blocks when in-scope similarity is below the minimum even if higher than out-of-scope", () => {
    const d = decideGuardrailOutcome(false, 0.2, 0.1, 0.35);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("out_of_scope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run test/guardrail.test.ts
```

Expected: FAIL — `Cannot find module '../src/guardrail'`.

- [ ] **Step 3: Implement guardrail.ts**

`worker/src/guardrail.ts`:

```typescript
export type GuardrailReason = "age_inappropriate" | "out_of_scope" | "guardrail_error" | null;

export interface GuardrailDecision {
  allowed: boolean;
  reason: GuardrailReason;
  refusalMessage: string | null;
}

// Specific phrases only - bare words like "drugs" or "sex" also appear in
// legitimate biology/chemistry curriculum content (drug interactions,
// sexual reproduction in plants, etc.) and would false-positive block them.
const BLOCKED_PHRASES = [
  "hurt myself", "kill myself", "self harm", "self-harm", "suicide",
  "cut myself", "want to die",
  "buy drugs", "illegal drugs", "get high", "cocaine", "heroin", "drug dealer",
  "porn", "nude photos", "naked pics", "send nudes",
  "kill someone", "how to make a bomb", "how to make a weapon",
];

export const IN_SCOPE_EXAMPLE_QUESTIONS = [
  "What is Newton's second law of motion?",
  "How do you factorise a quadratic equation?",
  "Explain the process of photosynthesis.",
  "What is the difference between speed and velocity?",
  "How do you find the derivative of a function?",
  "What are the states of matter?",
  "Explain Ohm's law with an example.",
  "How do you solve a system of linear equations?",
  "What is the periodic table and how is it organized?",
  "What is the Pythagorean theorem?",
];

export const OUT_OF_SCOPE_EXAMPLE_QUESTIONS = [
  "Who won the football match yesterday?",
  "What's the best movie to watch this weekend?",
  "Can you help me write a message to ask someone out?",
  "What's your favorite celebrity gossip?",
  "How do I get more followers on social media?",
  "Tell me a joke about my teacher.",
  "What should I cook for dinner tonight?",
  "Give me relationship advice.",
];

export const REFUSAL_AGE_INAPPROPRIATE =
  "I can't help with that here. If you're going through something difficult, " +
  "please talk to a teacher, parent, or trusted adult. I'm happy to help with " +
  "science and maths questions any time!";

export const REFUSAL_OUT_OF_SCOPE =
  "I can only help with science and maths topics here. Try asking me something " +
  "from your science or maths syllabus!";

export const REFUSAL_GUARDRAIL_ERROR =
  "I'm temporarily unable to check that question - please try again in a moment.";

export const DEFAULT_MIN_IN_SCOPE_SIMILARITY = 0.35;

export function containsBlockedKeyword(question: string): boolean {
  const text = question.toLowerCase();
  return BLOCKED_PHRASES.some((phrase) => text.includes(phrase));
}

export function decideGuardrailOutcome(
  keywordBlocked: boolean,
  inScopeSimilarity: number,
  outScopeSimilarity: number,
  minInScopeSimilarity: number = DEFAULT_MIN_IN_SCOPE_SIMILARITY
): GuardrailDecision {
  if (keywordBlocked) {
    return { allowed: false, reason: "age_inappropriate", refusalMessage: REFUSAL_AGE_INAPPROPRIATE };
  }

  if (inScopeSimilarity < minInScopeSimilarity || inScopeSimilarity <= outScopeSimilarity) {
    return { allowed: false, reason: "out_of_scope", refusalMessage: REFUSAL_OUT_OF_SCOPE };
  }

  return { allowed: true, reason: null, refusalMessage: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run test/guardrail.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/guardrail.ts worker/test/guardrail.test.ts
git commit -m "Port guardrail decision logic, fix bare-keyword false-positive bug"
```

---

### Task 4: Wire the guardrail to Workers AI embeddings (fail closed)

**Files:**
- Create: `worker/src/guardrailCheck.ts`
- Modify: `worker/src/index.ts` (add `Env` fields if missing — already present from Task 1)

**Interfaces:**
- Consumes: `GuardrailDecision`, `decideGuardrailOutcome`, `containsBlockedKeyword`, `IN_SCOPE_EXAMPLE_QUESTIONS`, `OUT_OF_SCOPE_EXAMPLE_QUESTIONS`, `REFUSAL_GUARDRAIL_ERROR` from `./guardrail`.
- Produces:
  ```typescript
  function checkQueryInScopeAndAgeAppropriate(question: string, ai: Ai): Promise<GuardrailDecision>
  ```
  Later tasks (chat.ts) call this before anything else.

This task is integration glue (Workers AI binding) and is verified manually via `wrangler dev` in Task 9's end-to-end pass, not unit tested — there is no meaningful way to unit test a live Workers AI call without a running binding. The fail-closed error path is straightforward `try/catch` and is easy to eyeball-verify.

- [ ] **Step 1: Implement guardrailCheck.ts**

`worker/src/guardrailCheck.ts`:

```typescript
import {
  containsBlockedKeyword,
  decideGuardrailOutcome,
  IN_SCOPE_EXAMPLE_QUESTIONS,
  OUT_OF_SCOPE_EXAMPLE_QUESTIONS,
  REFUSAL_GUARDRAIL_ERROR,
  type GuardrailDecision,
} from "./guardrail";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

function meanCosineSimilarity(vector: number[], referenceVectors: number[][]): number {
  const sims = referenceVectors.map((ref) => cosineSimilarity(vector, ref));
  return sims.reduce((a, b) => a + b, 0) / sims.length;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let cachedReferenceEmbeddings: { inScope: number[][]; outScope: number[][] } | null = null;

async function getReferenceEmbeddings(ai: Ai) {
  if (cachedReferenceEmbeddings) return cachedReferenceEmbeddings;

  const inScopeResp = await ai.run(EMBEDDING_MODEL, { text: IN_SCOPE_EXAMPLE_QUESTIONS });
  const outScopeResp = await ai.run(EMBEDDING_MODEL, { text: OUT_OF_SCOPE_EXAMPLE_QUESTIONS });

  cachedReferenceEmbeddings = {
    inScope: (inScopeResp as { data: number[][] }).data,
    outScope: (outScopeResp as { data: number[][] }).data,
  };
  return cachedReferenceEmbeddings;
}

/**
 * The real, wired-up guardrail gate: keyword hard-block plus Workers-AI
 * embedding similarity against reference question sets. Fails CLOSED -
 * any error (Workers AI unreachable, malformed response, etc.) blocks the
 * question with a distinct "guardrail_error" reason/message rather than
 * silently letting it through or looking like a normal policy refusal.
 */
export async function checkQueryInScopeAndAgeAppropriate(
  question: string,
  ai: Ai
): Promise<GuardrailDecision> {
  try {
    const keywordBlocked = containsBlockedKeyword(question);

    const { inScope, outScope } = await getReferenceEmbeddings(ai);
    const questionResp = await ai.run(EMBEDDING_MODEL, { text: [question] });
    const questionVector = (questionResp as { data: number[][] }).data[0];

    const inScopeSimilarity = meanCosineSimilarity(questionVector, inScope);
    const outScopeSimilarity = meanCosineSimilarity(questionVector, outScope);

    return decideGuardrailOutcome(keywordBlocked, inScopeSimilarity, outScopeSimilarity);
  } catch (err) {
    console.error("guardrail_error", err);
    return { allowed: false, reason: "guardrail_error", refusalMessage: REFUSAL_GUARDRAIL_ERROR };
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/guardrailCheck.ts
git commit -m "Wire guardrail to Workers AI embeddings, fail closed on error"
```

(Live verification of this against a real Workers AI binding happens in Task 9's end-to-end pass.)

---

### Task 5: Retrieval + rerank with graceful fallback

**Files:**
- Create: `worker/src/rerank.ts`
- Test: `worker/test/rerank.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```typescript
  interface RetrievedChunk {
    text: string; page: number; pageEnd: number; source: string;
    chunkId: number; cosineScore: number;
  }
  interface RerankedChunk extends RetrievedChunk { rerankScore: number | null; }
  type ScoreFn = (query: string, candidates: RetrievedChunk[]) => Promise<number[]>;
  function rerank(query: string, candidates: RetrievedChunk[], scoreFn: ScoreFn): Promise<RerankedChunk[]>
  function workersAiScoreFn(ai: Ai): ScoreFn
  ```
  `chat.ts` (Task 9) calls `rerank(query, candidates, workersAiScoreFn(env.AI))`. `rerank`'s `scoreFn` parameter is injectable so the fallback behavior is unit-testable without a live Workers AI binding.

- [ ] **Step 1: Write the failing tests**

`worker/test/rerank.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { rerank, type RetrievedChunk, type ScoreFn } from "../src/rerank";

const candidates: RetrievedChunk[] = [
  { text: "irrelevant passage", page: 1, pageEnd: 1, source: "a.pdf", chunkId: 0, cosineScore: 0.7 },
  { text: "the actually relevant passage", page: 2, pageEnd: 2, source: "a.pdf", chunkId: 1, cosineScore: 0.6 },
];

describe("rerank", () => {
  it("re-sorts candidates by the score function's output, most relevant first", async () => {
    const scoreFn: ScoreFn = async () => [0.2, 0.9];

    const result = await rerank("query", candidates, scoreFn);

    expect(result[0].text).toBe("the actually relevant passage");
    expect(result[0].rerankScore).toBe(0.9);
    expect(result[1].rerankScore).toBe(0.2);
  });

  it("falls back to original cosine order with null rerankScore when the score function throws", async () => {
    const scoreFn: ScoreFn = async () => { throw new Error("Workers AI unreachable"); };

    const result = await rerank("query", candidates, scoreFn);

    expect(result.map((c) => c.text)).toEqual(candidates.map((c) => c.text));
    expect(result.every((c) => c.rerankScore === null)).toBe(true);
  });

  it("returns an empty array unchanged", async () => {
    const scoreFn: ScoreFn = async () => [];
    expect(await rerank("query", [], scoreFn)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run test/rerank.test.ts
```

Expected: FAIL — `Cannot find module '../src/rerank'`.

- [ ] **Step 3: Implement rerank.ts**

`worker/src/rerank.ts`:

```typescript
export interface RetrievedChunk {
  text: string;
  page: number;
  pageEnd: number;
  source: string;
  chunkId: number;
  cosineScore: number;
}

export interface RerankedChunk extends RetrievedChunk {
  rerankScore: number | null;
}

export type ScoreFn = (query: string, candidates: RetrievedChunk[]) => Promise<number[]>;

/**
 * Cross-encoder-style reranking: re-scores each (query, chunk) pair
 * jointly instead of relying on cosine similarity alone. Never throws -
 * if scoreFn fails (model unavailable, network error), candidates come
 * back in their original cosine order with rerankScore=null, same
 * fallback philosophy as the Python app's reranker.py.
 */
export async function rerank(
  query: string,
  candidates: RetrievedChunk[],
  scoreFn: ScoreFn
): Promise<RerankedChunk[]> {
  if (candidates.length === 0) return [];

  try {
    const scores = await scoreFn(query, candidates);
    return candidates
      .map((c, i) => ({ ...c, rerankScore: scores[i] }))
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  } catch (err) {
    console.error("rerank failed, falling back to cosine order", err);
    return candidates.map((c) => ({ ...c, rerankScore: null }));
  }
}

/**
 * Real scoreFn backed by Cloudflare Workers AI's reranker model. Model id
 * to be confirmed against Workers AI's current catalog at deploy time -
 * "@cf/baai/bge-reranker-base" is the expected name as of this writing.
 */
export function workersAiScoreFn(ai: Ai): ScoreFn {
  return async (query, candidates) => {
    const response = await ai.run("@cf/baai/bge-reranker-base", {
      query,
      contexts: candidates.map((c) => ({ text: c.text })),
    });
    const results = (response as { response: { id: number; score: number }[] }).response;
    const scoreById = new Map(results.map((r) => [r.id, r.score]));
    return candidates.map((_, i) => scoreById.get(i) ?? 0);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run test/rerank.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/rerank.ts worker/test/rerank.test.ts
git commit -m "Add rerank stage with graceful cosine-order fallback"
```

---

### Task 6: JEV relevance filter

**Files:**
- Create: `worker/src/jev.ts`
- Test: `worker/test/jev.test.ts`

**Interfaces:**
- Consumes: `RerankedChunk` from `./rerank`.
- Produces:
  ```typescript
  interface JevScoredChunk extends RerankedChunk { jevRelevance: number | null; jevBlocked: boolean; }
  function filterByJevScores(
    chunks: RerankedChunk[],
    scores: { relevance: number; injection: number }[],
    relMin?: number,
    injMax?: number
  ): JevScoredChunk[]
  function callJev(
    query: string, chunks: RerankedChunk[], apiKey: string
  ): Promise<JevScoredChunk[]>
  ```
  `callJev` never throws - on any failure it returns every chunk unfiltered with `jevRelevance: null, jevBlocked: false` (JEV disabled/unreachable = pass everything through, same graceful-degradation philosophy as rerank.ts).

- [ ] **Step 1: Write the failing tests**

`worker/test/jev.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { filterByJevScores } from "../src/jev";
import type { RerankedChunk } from "../src/rerank";

const chunks: RerankedChunk[] = [
  { text: "relevant", page: 1, pageEnd: 1, source: "a.pdf", chunkId: 0, cosineScore: 0.7, rerankScore: 0.8 },
  { text: "irrelevant", page: 2, pageEnd: 2, source: "a.pdf", chunkId: 1, cosineScore: 0.6, rerankScore: 0.4 },
  { text: "hostile injection attempt", page: 3, pageEnd: 3, source: "a.pdf", chunkId: 2, cosineScore: 0.5, rerankScore: 0.3 },
];

describe("filterByJevScores", () => {
  it("keeps chunks at/above the relevance threshold and below the injection threshold", () => {
    const scores = [
      { relevance: 2.5, injection: 0.1 },
      { relevance: 1.0, injection: 0.1 },
      { relevance: 2.0, injection: 0.9 },
    ];

    const result = filterByJevScores(chunks, scores, 2, 0.5);

    expect(result.map((c) => c.text)).toEqual(["relevant"]);
  });

  it("uses the default thresholds (relMin=2, injMax=0.5) when not specified", () => {
    const scores = [
      { relevance: 2.0, injection: 0.1 },
      { relevance: 1.9, injection: 0.1 },
    ];

    const result = filterByJevScores(chunks.slice(0, 2), scores);

    expect(result.map((c) => c.text)).toEqual(["relevant"]);
  });
});

describe("callJev", () => {
  it("passes chunks through unfiltered (not dropped) when the JEV request fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network unreachable"); };

    try {
      const { callJev } = await import("../src/jev");
      const result = await callJev("query", chunks, "fake-key");

      expect(result.length).toBe(chunks.length);
      expect(result.every((c) => c.jevRelevance === null && c.jevBlocked === false)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run test/jev.test.ts
```

Expected: FAIL — `Cannot find module '../src/jev'`.

- [ ] **Step 3: Implement jev.ts**

`worker/src/jev.ts`:

```typescript
import type { RerankedChunk } from "./rerank";

export interface JevScoredChunk extends RerankedChunk {
  jevRelevance: number | null;
  jevBlocked: boolean;
}

const DEFAULT_REL_MIN = 2;
const DEFAULT_INJ_MAX = 0.5;

export function filterByJevScores(
  chunks: RerankedChunk[],
  scores: { relevance: number; injection: number }[],
  relMin: number = DEFAULT_REL_MIN,
  injMax: number = DEFAULT_INJ_MAX
): JevScoredChunk[] {
  return chunks
    .map((chunk, i) => ({
      ...chunk,
      jevRelevance: scores[i]?.relevance ?? null,
      jevBlocked: (scores[i]?.injection ?? 0) >= injMax,
    }))
    .filter((c) => (c.jevRelevance ?? 0) >= relMin && !c.jevBlocked);
}

/**
 * Calls JEV to score each chunk's relevance to the query and probe for
 * injected instructions. Never throws - on any failure (network error,
 * bad response, JEV disabled) returns every input chunk unfiltered with
 * jevRelevance=null, jevBlocked=false, so callers degrade to "JEV didn't
 * run" rather than losing the whole request.
 */
export async function callJev(
  query: string,
  chunks: RerankedChunk[],
  apiKey: string
): Promise<JevScoredChunk[]> {
  if (chunks.length === 0) return [];

  try {
    const response = await fetch("https://api.typesafe.ai/v1/jev/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        chunks: chunks.map((c) => c.text),
      }),
    });

    if (!response.ok) {
      throw new Error(`JEV returned ${response.status}`);
    }

    const body = (await response.json()) as {
      scores: { relevance: number; injection: number }[];
    };

    return filterByJevScores(chunks, body.scores);
  } catch (err) {
    console.error("JEV call failed, passing chunks through unfiltered", err);
    return chunks.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run test/jev.test.ts
```

Expected: PASS (3 tests) — this includes the combined-failure case: if `rerank`'s scoreFn is also down (Task 5's fallback already covers that in isolation), `callJev`'s own independent fallback here confirms the chat pipeline still gets chunks through even when both optional stages fail at once, satisfying the "JEV and reranker both unreachable" Review Focus item together with Task 5's fallback test.

- [ ] **Step 5: Commit**

```bash
git add worker/src/jev.ts worker/test/jev.test.ts
git commit -m "Add JEV relevance filter with pass-through fallback"
```

*(Note: `callJev`'s exact endpoint/request-body shape is written from the JEV/OpenRouter documentation summarized during design and must be confirmed against JEV's actual API reference before Task 9's live end-to-end test - flag this explicitly when starting Task 9 if the endpoint differs.)*

---

### Task 7: Web search fallback (DuckDuckGo)

**Files:**
- Create: `worker/src/webSearch.ts`
- Test: `worker/test/webSearch.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface WebResult { title: string; url: string; snippet: string; }
  function formatWebResultsAsContext(results: WebResult[]): string
  function webSearch(query: string, maxResults?: number): Promise<WebResult[]>
  ```

- [ ] **Step 1: Write the failing test**

`worker/test/webSearch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatWebResultsAsContext, type WebResult } from "../src/webSearch";

describe("formatWebResultsAsContext", () => {
  it("formats results as markdown-linked title + snippet blocks", () => {
    const results: WebResult[] = [
      { title: "Newton's Laws", url: "https://example.com/newton", snippet: "Three laws of motion." },
    ];

    const text = formatWebResultsAsContext(results);

    expect(text).toContain("[Newton's Laws](https://example.com/newton)");
    expect(text).toContain("Three laws of motion.");
  });

  it("returns a clear no-results message for an empty list", () => {
    expect(formatWebResultsAsContext([])).toBe("No web results found.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run test/webSearch.test.ts
```

Expected: FAIL — `Cannot find module '../src/webSearch'`.

- [ ] **Step 3: Implement webSearch.ts**

`worker/src/webSearch.ts`:

```typescript
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export function formatWebResultsAsContext(results: WebResult[]): string {
  if (results.length === 0) return "No web results found.";
  return results.map((r) => `[${r.title}](${r.url})\n${r.snippet}`).join("\n\n");
}

/**
 * DuckDuckGo HTML search, no API key - same approach as web_search.py.
 * Never throws: returns an empty array on any failure so the chat
 * pipeline can fall back to "no web results" rather than a 500.
 */
export async function webSearch(query: string, maxResults = 5): Promise<WebResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; edu-live-bot/1.0)" },
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);

    const html = await response.text();
    const results: WebResult[] = [];
    const resultRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      results.push({
        url: match[1],
        title: stripTags(match[2]),
        snippet: stripTags(match[3]),
      });
    }
    return results;
  } catch (err) {
    console.error("web search failed", err);
    return [];
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run test/webSearch.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/webSearch.ts worker/test/webSearch.test.ts
git commit -m "Add DuckDuckGo web-search fallback"
```

*(Note: DuckDuckGo's HTML structure can change; if Task 9's live test shows zero results being parsed, inspect the actual response HTML and adjust `resultRegex` accordingly - this is expected maintenance for an unofficial scrape, same caveat the Python `ddgs` dependency existed to paper over.)*

---

### Task 8: PDF parsing and the `/ingest` route

**Files:**
- Create: `worker/src/pdf.ts`
- Create: `worker/src/ingestion.ts`
- Modify: `worker/src/index.ts` (route `POST /ingest` to the new handler)

**Interfaces:**
- Consumes: `chunkText` from `./chunker`, `Env` from `./index`.
- Produces:
  ```typescript
  function extractPdfPages(pdfBytes: ArrayBuffer): Promise<PageText[]>
  async function handleIngest(request: Request, env: Env): Promise<Response>
  ```

- [ ] **Step 1: Implement PDF extraction**

`worker/src/pdf.ts`:

```typescript
import { extractText, getDocumentProxy } from "unpdf";
import type { PageText } from "./types";

/**
 * Extracts per-page text from a PDF's raw bytes using unpdf (PDF.js-based,
 * runs natively in the Workers JS runtime - no Pyodide/Python involved).
 */
export async function extractPdfPages(pdfBytes: ArrayBuffer): Promise<PageText[]> {
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes));
  const { totalPages, text } = await extractText(doc, { mergePages: false });

  const pages: PageText[] = [];
  const pageTexts = Array.isArray(text) ? text : [text];
  for (let i = 0; i < totalPages; i++) {
    pages.push({ page: i + 1, text: pageTexts[i] ?? "" });
  }
  return pages;
}
```

- [ ] **Step 2: Implement the ingestion route**

`worker/src/ingestion.ts`:

```typescript
import type { Env } from "./index";
import { extractPdfPages } from "./pdf";
import { chunkText } from "./chunker";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!formData || !(file instanceof File)) {
    return Response.json({ error: "Expected multipart/form-data with a 'file' field" }, { status: 400 });
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return Response.json({ error: "Only PDF files are supported" }, { status: 400 });
  }

  const existing = await env.PDF_BUCKET.head(file.name);
  if (existing) {
    return Response.json({ status: "skipped", reason: "already indexed", source: file.name });
  }

  const pdfBytes = await file.arrayBuffer();
  await env.PDF_BUCKET.put(file.name, pdfBytes);

  const pages = await extractPdfPages(pdfBytes);
  if (pages.every((p) => p.text.trim() === "")) {
    return Response.json({ error: "No extractable text found in PDF" }, { status: 400 });
  }

  const chunks = chunkText(pages, file.name);

  const embedResponse = await env.AI.run(EMBEDDING_MODEL, {
    text: chunks.map((c) => c.text),
  });
  const vectors = (embedResponse as { data: number[][] }).data;

  await env.VECTORIZE.upsert(
    chunks.map((chunk, i) => ({
      id: `${chunk.source}::${chunk.chunkId}`,
      values: vectors[i],
      metadata: {
        text: chunk.text,
        source: chunk.source,
        page: chunk.page,
        pageEnd: chunk.pageEnd,
        chunkId: chunk.chunkId,
      },
    }))
  );

  return Response.json({ status: "indexed", source: file.name, chunkCount: chunks.length });
}
```

- [ ] **Step 3: Wire the route into index.ts**

Modify `worker/src/index.ts`:

```typescript
import { handleIngest } from "./ingestion";

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
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

- [ ] **Step 4: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Manual smoke test against a real binding**

```bash
cd worker
npx wrangler dev --local --persist-to=.wrangler/state
curl -X POST http://localhost:8787/ingest -F "file=@test-fixtures/light-notes.pdf"
```

Expected: JSON response `{"status": "indexed", "source": "light-notes.pdf", "chunkCount": <N>}`. Re-run the same curl command — expect `{"status": "skipped", ...}` the second time (duplicate-filename skip).

Also verify the bad-input paths:

```bash
# no file field at all -> expect 400, not a crash
curl -X POST http://localhost:8787/ingest -F "notes=not-a-file-field"

# non-PDF file -> expect 400
echo "just some text" > /tmp/not-a-pdf.txt
curl -X POST http://localhost:8787/ingest -F "file=@/tmp/not-a-pdf.txt"
```

Expected: both return `{"error": "..."}` with a 400 status, and the Worker process stays up (check the `wrangler dev` terminal didn't crash).

- [ ] **Step 6: Commit**

```bash
git add worker/src/pdf.ts worker/src/ingestion.ts worker/src/index.ts
git commit -m "Add PDF extraction and POST /ingest route"
```

---

### Task 9: The `/chat` route — full pipeline wiring

**Files:**
- Create: `worker/src/chat.ts`
- Modify: `worker/src/index.ts` (route `POST /chat`)

**Interfaces:**
- Consumes: `checkQueryInScopeAndAgeAppropriate` from `./guardrailCheck`; `rerank`, `workersAiScoreFn`, `RetrievedChunk` from `./rerank`; `callJev` from `./jev`; `webSearch`, `formatWebResultsAsContext` from `./webSearch`; `Env` from `./index`.
- Produces:
  ```typescript
  async function handleChat(request: Request, env: Env): Promise<Response>
  ```

- [ ] **Step 1: Implement the chat handler**

`worker/src/chat.ts`:

```typescript
import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { callJev } from "./jev";
import { webSearch, formatWebResultsAsContext } from "./webSearch";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const TOP_K = 5;

const SYSTEM_PROMPT = `You are a helpful research assistant and teacher for 16-17 year old students.

Audience and scope:
- Only help with science and maths topics. If a question is outside that scope, politely decline.
- Keep language and content age-appropriate.

Policy:
- Answer only from the context provided below (documents and/or web results).
- If the context doesn't answer the question, say so clearly instead of guessing.
- Name the source document (with page number) or web page you used.
- Keep answers concise unless the question needs detail.`;

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as { question?: string } | null;
  const question = body?.question?.trim();

  if (!question) {
    return Response.json({ error: "Expected JSON body with a 'question' field" }, { status: 400 });
  }

  if (env.GUARDRAIL_ENABLED === "true") {
    const decision = await checkQueryInScopeAndAgeAppropriate(question, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        { answer: decision.refusalMessage, reason: decision.reason, docSources: [], webSources: [] },
        { status }
      );
    }
  }

  const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [question] });
  const questionVector = (embedResponse as { data: number[][] }).data[0];

  const matches = await env.VECTORIZE.query(questionVector, { topK: TOP_K, returnMetadata: true });
  const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
    text: String(m.metadata?.text ?? ""),
    page: Number(m.metadata?.page ?? 0),
    pageEnd: Number(m.metadata?.pageEnd ?? 0),
    source: String(m.metadata?.source ?? ""),
    chunkId: Number(m.metadata?.chunkId ?? 0),
    cosineScore: m.score,
  }));

  const reranked = await rerank(question, retrieved, workersAiScoreFn(env.AI));

  const jevFiltered =
    env.JEV_ENABLED === "true"
      ? await callJev(question, reranked, env.JEV_API_KEY)
      : reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }));

  let docSources = jevFiltered;
  let webSources: Awaited<ReturnType<typeof webSearch>> = [];

  if (docSources.length === 0) {
    webSources = await webSearch(question);
  }

  const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
  const webContext = webSources.length > 0 ? formatWebResultsAsContext(webSources) : "";
  const context = [documentContext, webContext].filter(Boolean).join("\n\n---\n\n") || "No context found.";

  const generateResponse = await env.AI.run(GENERATION_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Question: ${question}\n\nContext:\n${context}` },
    ],
  });
  const answer = (generateResponse as { response: string }).response;

  return Response.json({
    answer,
    docSources: docSources.map((c) => ({ source: c.source, page: c.page, pageEnd: c.pageEnd, text: c.text })),
    webSources,
  });
}
```

- [ ] **Step 2: Wire the route into index.ts**

Modify `worker/src/index.ts`:

```typescript
import { handleIngest } from "./ingestion";
import { handleChat } from "./chat";

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
```

- [ ] **Step 3: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual end-to-end smoke test**

```bash
cd worker
npx wrangler secret put JEV_API_KEY --local   # paste a real JEV key when prompted
npx wrangler dev --local --persist-to=.wrangler/state

# in another terminal, with the dev server running:
curl -X POST http://localhost:8787/ingest -F "file=@test-fixtures/light-notes.pdf"
curl -X POST http://localhost:8787/chat -H "Content-Type: application/json" \
  -d '{"question": "What is the difference between reflection and refraction of light?"}'
```

Expected: the `/chat` response is a JSON object with a non-empty `answer` referencing the indexed PDF's content, and `docSources` pointing at `light-notes.pdf`.

Also verify each guardrail/degradation path manually:

```bash
# out-of-scope question -> should be refused, not answered
curl -X POST http://localhost:8787/chat -H "Content-Type: application/json" \
  -d '{"question": "Who won the football match yesterday?"}'

# empty Vectorize index (before any /ingest call) -> should not crash
# (run this against a fresh --persist-to state dir with nothing ingested yet)
curl -X POST http://localhost:8787/chat -H "Content-Type: application/json" \
  -d '{"question": "What is Newton'"'"'s second law?"}'
```

If the DuckDuckGo scrape in Task 7 returns zero results in this live test, inspect the actual HTML response and fix `resultRegex` in `webSearch.ts` before proceeding — this was flagged as expected maintenance when that task was written.

If the JEV endpoint/response shape in Task 6 doesn't match JEV's real API, fix `callJev` in `jev.ts` now against the real API reference before proceeding — that task explicitly flagged this as unconfirmed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/chat.ts worker/src/index.ts
git commit -m "Add POST /chat route: full guardrail->retrieve->rerank->JEV->web->generate pipeline"
```

---

### Task 10: Frontend (Pages) — upload and chat UI

**Files:**
- Modify: `frontend/index.html`
- Create: `frontend/app.js`
- Create: `frontend/style.css`

**Interfaces:**
- Consumes: the deployed Worker's `/ingest` and `/chat` endpoints (URL configured via a constant at the top of `app.js`).

- [ ] **Step 1: Build the page**

`frontend/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Edukripa</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main>
    <h1>Edukripa</h1>

    <section id="upload-section">
      <h2>Upload notes (PDF)</h2>
      <input type="file" id="file-input" accept="application/pdf" />
      <button id="upload-btn">Upload</button>
      <p id="upload-status"></p>
    </section>

    <section id="chat-section">
      <h2>Ask a question</h2>
      <div id="chat-log"></div>
      <form id="chat-form">
        <input type="text" id="question-input" placeholder="Ask a science or maths question..." required />
        <button type="submit">Send</button>
      </form>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
```

`frontend/style.css`:

```css
body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
#chat-log { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; min-height: 200px; margin-bottom: 1rem; }
.message { margin-bottom: 0.75rem; }
.message.user { font-weight: bold; }
.message.assistant { white-space: pre-wrap; }
#chat-form { display: flex; gap: 0.5rem; }
#question-input { flex: 1; padding: 0.5rem; }
```

- [ ] **Step 2: Wire it up to the Worker**

`frontend/app.js`:

```javascript
const WORKER_URL = "http://localhost:8787"; // replace with the deployed Worker URL

const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadStatus = document.getElementById("upload-status");
const chatForm = document.getElementById("chat-form");
const questionInput = document.getElementById("question-input");
const chatLog = document.getElementById("chat-log");

uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) {
    uploadStatus.textContent = "Choose a PDF first.";
    return;
  }

  uploadStatus.textContent = "Uploading...";
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${WORKER_URL}/ingest`, { method: "POST", body: formData });
  const result = await response.json();

  uploadStatus.textContent = response.ok
    ? `${result.status}: ${result.source}${result.chunkCount ? ` (${result.chunkCount} chunks)` : ""}`
    : `Error: ${result.error}`;
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";

  const response = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const result = await response.json();

  appendMessage("assistant", result.answer ?? `Error: ${result.error}`);
});

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}
```

- [ ] **Step 3: Manual browser verification**

```bash
cd frontend
npx serve .
```

Open the served URL, confirm the page loads, upload `worker/test-fixtures/light-notes.pdf`, and ask a question through the chat form — confirm the answer appears (requires Task 9's `wrangler dev` running concurrently at `WORKER_URL`).

- [ ] **Step 4: Commit**

```bash
git add frontend/
git commit -m "Add Pages frontend: PDF upload + chat UI"
```

---

### Task 11: Deploy and final end-to-end verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- None — this task is deployment and verification, not new code.

- [ ] **Step 1: Create the Cloudflare resources**

```bash
cd worker
npx wrangler vectorize create edu-live-chunks --dimensions=768 --metric=cosine
npx wrangler r2 bucket create edu-live-pdfs
npx wrangler secret put JEV_API_KEY   # paste the real JEV key
```

- [ ] **Step 2: Deploy the Worker**

```bash
npx wrangler deploy
```

Note the deployed Worker URL from the output.

- [ ] **Step 3: Deploy the frontend**

Update `WORKER_URL` in `frontend/app.js` to the deployed Worker URL from Step 2, then:

```bash
cd ../frontend
npx wrangler pages deploy . --project-name=edu-live-frontend
```

- [ ] **Step 4: Full production smoke test**

Open the deployed Pages URL in a browser. Upload one of the test PDFs, ask an in-scope question (confirm a relevant, sourced answer), ask an out-of-scope question (confirm a graceful refusal), and check `npx wrangler tail` in a terminal to confirm each pipeline stage (guardrail verdict, retrieval count, rerank/JEV outcome, routing path) is visible in the logs.

- [ ] **Step 5: Update README with real setup/deploy instructions**

Replace `README.md` with accurate instructions covering: prerequisites (Cloudflare account, `wrangler login`), the resource-creation commands from Step 1, `npm install` in both `worker/` and running `npx serve` for local frontend dev, and the deploy commands from Steps 2-3.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document Cloudflare deploy steps, complete first working end-to-end pass"
```

---

## Deferred follow-ups (not in this plan, captured for next round)

- Agentic multi-turn tool-calling loop (model decides to re-search), replacing the fixed pipeline.
- Richer observability (persistent logging/dashboard) beyond `wrangler tail` — user wants more options considered here.
- Config-management revisit (per-environment config, threshold tuning surface) — user wants to revisit this later.
- Response-style features from the handwritten requirements notes (simple/elaborate answers, sentence-count options, question-paper generation) — explicitly out of scope for this migration.
