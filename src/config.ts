import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "..", ".env"), quiet: true });

const Env = z.object({
  SUPABASE_POOLER_URL: z.string().min(10).optional(),
  SUPABASE_DB_URL: z.string().min(10).optional(),
  OLLAMA_HOST: z.string().url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),
  MEMORY_ROOTS: z.string().min(1),
  CHUNK_SIZE: z.coerce.number().int().positive().default(800),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(100),
  SCM_DELEGATION_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  // ─── Native web-research tools (fetch_url + research_url) ────────────────
  SCM_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SCM_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2000000),
  SCM_FETCH_MAX_RETURN_CHARS: z.coerce.number().int().positive().default(20000),
  SCM_FETCH_ALLOW_PRIVATE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  SCM_FETCH_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  // ─── Bounded docs crawler (crawl_docs) — SCM-S49-D2 ──────────────────────
  // All env-overridable; tool args override env at the handler boundary.
  CRAWL_MAX_DEPTH: z.coerce.number().int().nonnegative().default(2),
  CRAWL_MAX_PAGES: z.coerce.number().int().positive().default(50),
  CRAWL_MAX_PAGES_PER_DOMAIN: z.coerce.number().int().positive().default(50),
  CRAWL_POLITENESS_MS: z.coerce.number().int().nonnegative().default(1000),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(3),
  CRAWL_EMBED_BATCH: z.coerce.number().int().positive().default(16),
  CRAWL_TIMEOUT_TOTAL_MS: z.coerce.number().int().positive().default(120000),
  // ─── Graph-aware retrieval re-rank (SCM-S50, concept-bridge) ─────────────
  // Ships OFF; alpha=1 ≡ pure vector. No decay knob (bridge is fixed 2-hop).
  SCM_GRAPH_RERANK_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  SCM_GRAPH_RERANK_ALPHA: z.coerce.number().min(0).max(1).default(0.7),
  SCM_GRAPH_RERANK_POOL: z.coerce.number().int().positive().default(40),
  SCM_GRAPH_RERANK_EXPAND: z.coerce.number().int().nonnegative().default(10),
  // Per-call ceiling for the two bridge round-trips (fetchConceptChunks +
  // fetchChunksByIds). The original 50ms default sat *below* real Supabase
  // round-trip latency (measured 167-213ms in SCM-S51), so withTimeout fired
  // before the first RPC returned and the rerank silently fell back to pure
  // vector on EVERY query — the feature never actually ran. 1500ms = ~7x headroom.
  SCM_GRAPH_RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  // SCM-S53 — confidence gate (margin signal). Skip the graph bridge entirely
  // when the pure-vector neighborhood is PEAKED: margin = top1 - top2 ≥ this
  // value ⇒ the vector is confident ⇒ return pure vector (protects the control
  // set from rerank demotion + saves the two bridge round-trips). Probe v1
  // proved ABSOLUTE top-1 similarity cannot separate control from lift (medians
  // 0.7131 vs 0.6941, no gap — nomic-embed packs everything into a narrow band);
  // Probe v2 showed the abs MARGIN does (control 1.79× higher at median, 3.1× at
  // p75). 0.02 sits mid-overlap; tune via scripts/probe-margin-signal.ts.
  SCM_GRAPH_MARGIN_THRESHOLD: z.coerce.number().min(0).max(1).default(0.02),
  // ─── LLM listwise reranker (SCM-S54) ─────────────────────────────────────
  // Confidence-gated precision layer atop nomic-embed vector recall. Ships ON
  // (SCM-S54 bake-off verdict): qwen3-coder:480b-cloud + the non-demoting top-1
  // pin cleanly clears the strict flip-rule (recall@3 lift with zero confident-
  // gold regression). It fires ONLY on FLAT vector neighborhoods (reuses
  // SCM_GRAPH_MARGIN_THRESHOLD — the same low-confidence gate as the graph
  // bridge) and is MUTUALLY EXCLUSIVE with the graph rerank. The winning model
  // is the default; set SCM_RERANK_MODEL to override, or SCM_LLM_RERANK_ENABLED
  // =false to fall back to pure vector order.
  SCM_LLM_RERANK_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  SCM_RERANK_MODEL: z.string().default("qwen3-coder:480b-cloud"),
  SCM_LLM_RERANK_POOL: z.coerce.number().int().positive().default(12),
  SCM_LLM_RERANK_SNIPPET: z.coerce.number().int().positive().default(400),
  SCM_LLM_RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // SCM-S54 non-demoting top-1 pin (ports the SCM-S53 graph-rerank anchor to the
  // LLM path). Default TRUE: when the LLM permutation demotes the strongest
  // semantic anchor (MAX vector similarity) out of rank 1, re-pin it to rank 1
  // and keep the LLM's relative order for the rest. The qwen bake-off recovered
  // recall@3 0→0.24 but regressed control by one confident top-1 gold; this pin
  // protects that case. No effect when SCM_LLM_RERANK_ENABLED=false.
  SCM_LLM_RERANK_PIN_TOP1: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
}).refine((v) => Boolean(v.SUPABASE_POOLER_URL) || Boolean(v.SUPABASE_DB_URL), {
  message:
    "At least one of SUPABASE_POOLER_URL (preferred, IPv4) or SUPABASE_DB_URL must be set",
  path: ["SUPABASE_POOLER_URL"],
});

function parseEnv(): z.infer<typeof Env> {
  const r = Env.safeParse(process.env);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  const msg = [
    "[smart-claude-memory] Environment is not configured.",
    "Copy .env.example to .env and set the required vars (see README §Quick start).",
    "Missing or invalid:",
    ...lines,
  ].join("\n");
  console.error(msg);
  process.exit(1);
}

export const config = parseEnv();

export const memoryRoots = config.MEMORY_ROOTS
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
