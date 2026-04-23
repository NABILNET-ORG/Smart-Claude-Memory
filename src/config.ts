import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "..", ".env"), quiet: true });

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(10),
  SUPABASE_DB_URL: z.string().min(10),
  OLLAMA_HOST: z.string().url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),
  MEMORY_ROOTS: z.string().min(1),
  CHUNK_SIZE: z.coerce.number().int().positive().default(800),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(100),
});

export const config = Env.parse(process.env);

export const memoryRoots = config.MEMORY_ROOTS
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
