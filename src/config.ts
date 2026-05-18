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
