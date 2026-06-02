// MCP tool: export_global_vault
//
// Serialize the reserved 'GLOBAL' Knowledge Vault (memory_chunks rows where
// project_id='GLOBAL') to a portable, PURELY DETERMINISTIC JSON package that
// can be imported into another SCM instance without overriding local data.
//
// Determinism contract (see docs/superpowers/specs/2026-06-02-global-vault-
// export-import-design.md §2):
//   - chunks sorted by (content_hash, file_origin, chunk_index);
//   - volatile fields (id, updated_at, project_id) excluded;
//   - canonical key-sorted JSON, fixed 2-space indent;
//   - content_digest = sha256 over canonicalJSON(chunks) — content-only, so it
//     is independent of the SCM generator version.
//
// Embeddings are shipped INSIDE the package (Ollama embeddings are not
// reproducible bit-for-bit across model versions, so re-embedding at import is
// not an option). That makes the payload large → it is written to a FILE, never
// returned inline.

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { supabase } from "../supabase.js";
import { config } from "../config.js";
import { VERSION } from "../version.js";
import { canonicalJSON, sha256Hex } from "../canonical-json.js";

const GLOBAL_PROJECT_ID = "GLOBAL";
const PAGE_SIZE = 1000;

export type GlobalVaultChunk = {
  content_hash: string;
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  embedding: number[];
};

export type GlobalVaultPackage = {
  format: "scm-global-vault";
  format_version: "1.0.0";
  scope: "GLOBAL";
  embedding: { model: string; dim: number };
  generator: { tool: "smart-claude-memory"; version: string };
  count: number;
  content_digest: string;
  chunks: GlobalVaultChunk[];
};

export type ExportGlobalVaultArgs = {
  out_path?: string;
  // `pretty` is accepted for forward-compatibility with the design's tool
  // signature. The canonical serializer is ALWAYS pretty (2-space indent) so
  // exports stay byte-stable; a "compact" mode would break the determinism
  // contract, so the flag is intentionally a no-op.
  pretty?: boolean;
};

export type ExportGlobalVaultResult = {
  ok: true;
  path: string;
  scope: "GLOBAL";
  count: number;
  content_digest: string;
  bytes: number;
  embed_model: string;
  embed_dim: number;
};

type RawRow = {
  content: string | null;
  embedding: unknown;
  file_origin: string | null;
  chunk_index: number | null;
  content_hash: string | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Coerce a pgvector value into a number[]. supabase-js may hand back the
 * embedding either already-parsed (number[]) or as the Postgres text form
 * '[0.1,0.2,...]' depending on column/driver. Both are normalized here.
 */
function normalizeEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => (typeof v === "number" ? v : Number(v)));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `export_global_vault: could not parse embedding string "${trimmed.slice(0, 32)}…"`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("export_global_vault: parsed embedding is not an array");
    }
    return parsed.map((v) => (typeof v === "number" ? v : Number(v)));
  }
  throw new Error(
    `export_global_vault: unexpected embedding type "${typeof raw}"`,
  );
}

/** Page through every GLOBAL row, selecting the fields the package needs. */
async function fetchAllGlobalRows(): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("content, embedding, file_origin, chunk_index, content_hash, metadata")
      .eq("project_id", GLOBAL_PROJECT_ID)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`export_global_vault SELECT failed: ${error.message}`);
    }
    const page = (data ?? []) as RawRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

/** Stable sort comparator: content_hash, then file_origin, then chunk_index. */
function compareChunks(a: GlobalVaultChunk, b: GlobalVaultChunk): number {
  if (a.content_hash !== b.content_hash) {
    return a.content_hash < b.content_hash ? -1 : 1;
  }
  if (a.file_origin !== b.file_origin) {
    return a.file_origin < b.file_origin ? -1 : 1;
  }
  return a.chunk_index - b.chunk_index;
}

export async function exportGlobalVault(
  args: ExportGlobalVaultArgs = {},
): Promise<ExportGlobalVaultResult> {
  const rawRows = await fetchAllGlobalRows();

  const chunks: GlobalVaultChunk[] = rawRows.map((r) => ({
    content_hash: (r.content_hash ?? "") as string,
    content: (r.content ?? "") as string,
    file_origin: (r.file_origin ?? "") as string,
    chunk_index: (r.chunk_index ?? 0) as number,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    embedding: normalizeEmbedding(r.embedding),
  }));

  chunks.sort(compareChunks);

  const contentDigest = `sha256:${sha256Hex(canonicalJSON(chunks))}`;

  const pkg: GlobalVaultPackage = {
    format: "scm-global-vault",
    format_version: "1.0.0",
    scope: "GLOBAL",
    embedding: { model: config.OLLAMA_EMBED_MODEL, dim: config.EMBED_DIM },
    generator: { tool: "smart-claude-memory", version: VERSION },
    count: chunks.length,
    content_digest: contentDigest,
    chunks,
  };

  const outPath =
    args.out_path ??
    path.join(os.homedir(), ".claude-memory", "exports", "global-vault.json");

  await mkdir(path.dirname(outPath), { recursive: true });

  const serialized = canonicalJSON(pkg);
  await writeFile(outPath, serialized, "utf8");

  return {
    ok: true,
    path: outPath,
    scope: "GLOBAL",
    count: chunks.length,
    content_digest: contentDigest,
    bytes: Buffer.byteLength(serialized, "utf8"),
    embed_model: config.OLLAMA_EMBED_MODEL,
    embed_dim: config.EMBED_DIM,
  };
}
