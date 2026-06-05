import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "..", ".env"), quiet: true });

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(10),
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
