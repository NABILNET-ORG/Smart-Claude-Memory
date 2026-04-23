import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { memoryRoots } from "../config.js";
import { chunkMarkdown } from "../chunker.js";
import { embed } from "../ollama.js";
import { upsertChunks } from "../supabase.js";
import { currentProjectId } from "../project.js";

export async function syncLocalMemory(
  args: { roots?: string[]; project_id?: string } = {},
) {
  const projectId = args.project_id ?? currentProjectId;
  const roots = args.roots?.length ? args.roots : memoryRoots;

  const files: string[] = [];
  for (const root of roots) {
    const matched = await glob("**/*.md", {
      cwd: root,
      absolute: true,
      nodir: true,
      ignore: ["**/node_modules/**", "**/dist/**", "**/backups/**"],
    });
    files.push(...matched);
  }

  let total = 0;
  const perFile: Array<{ file: string; chunks: number }> = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (!text.trim()) continue;

    const raw = chunkMarkdown(text);
    if (raw.length === 0) continue;

    const embeddings = await embed(raw.map((r) => r.content));
    const rows = raw.map((r, i) => ({
      content: r.content,
      file_origin: file,
      chunk_index: r.chunk_index,
      embedding: embeddings[i],
      metadata: r.heading ? { heading: r.heading } : {},
    }));

    const { count } = await upsertChunks(projectId, rows);
    total += count;
    perFile.push({ file, chunks: count });
  }

  return {
    project_id: projectId,
    total_chunks: total,
    files_processed: perFile.length,
    files: perFile,
  };
}
