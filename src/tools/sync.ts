import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { memoryRoots } from "../config.js";
import { chunkMarkdown } from "../chunker.js";
import { embed } from "../ollama.js";
import {
  upsertChunks,
  listFileHashes,
  deleteChunksForFile,
  md5,
  type ChunkRow,
} from "../supabase.js";
import { currentProjectId } from "../project.js";

const BATCH_SIZE = 100;

export type SyncResult = {
  project_id: string;
  force: boolean;
  scanned: number;
  skipped: number;
  added: number;
  updated: number;
  orphans: number;
  orphan_files: string[];
  chunks_upserted: number;
  chunks_deleted: number;
  ms: number;
};

export async function syncLocalMemory(
  args: { roots?: string[]; project_id?: string; force?: boolean } = {},
): Promise<SyncResult> {
  const started = Date.now();
  const projectId = args.project_id ?? currentProjectId;
  const roots = args.roots?.length ? args.roots : memoryRoots;
  const force = Boolean(args.force);

  // 1. Snapshot remote state. Always fetched so that `force` still detects "update vs add"
  //    correctly and deletes stale chunks for files that may have shrunk.
  const existing = await listFileHashes(projectId);

  // 2. Enumerate local markdown
  const localFiles: string[] = [];
  for (const root of roots) {
    const matched = await glob("**/*.md", {
      cwd: root,
      absolute: true,
      nodir: true,
      ignore: ["**/node_modules/**", "**/dist/**", "**/backups/**"],
    });
    localFiles.push(...matched);
  }
  const localSet = new Set(localFiles);

  // 3. Classify each file; buffer chunks for bulk upsert
  let skipped = 0;
  let added = 0;
  let updated = 0;
  let chunksUpserted = 0;
  let chunksDeleted = 0;
  const buffer: ChunkRow[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const { count } = await upsertChunks(projectId, buffer);
    chunksUpserted += count;
    buffer.length = 0;
  };

  for (const file of localFiles) {
    const text = await readFile(file, "utf8");
    if (!text.trim()) continue;

    const hash = md5(text);
    const prior = existing.get(file);

    if (!force && prior === hash) {
      skipped++;
      continue;
    }

    const isUpdate = prior !== undefined;
    if (isUpdate) {
      // Flush pending inserts before delete so we don't orphan a half-written batch.
      // Deleting first also ensures stale chunks are removed if the file shrank
      // (new chunk count < old chunk count).
      await flush();
      const removed = await deleteChunksForFile(projectId, file);
      chunksDeleted += removed;
      updated++;
    } else {
      added++;
    }

    const raw = chunkMarkdown(text);
    if (raw.length === 0) continue;

    const embeddings = await embed(raw.map((r) => r.content));
    for (let i = 0; i < raw.length; i++) {
      buffer.push({
        content: raw[i].content,
        file_origin: file,
        chunk_index: raw[i].chunk_index,
        embedding: embeddings[i],
        file_hash: hash,
        metadata: raw[i].heading ? { heading: raw[i].heading } : {},
      });
      if (buffer.length >= BATCH_SIZE) await flush();
    }
  }
  await flush();

  // 4. Detect orphans (in DB, not on disk) — log only, no deletion
  const orphanFiles: string[] = [];
  for (const fileInDb of existing.keys()) {
    if (!localSet.has(fileInDb)) orphanFiles.push(fileInDb);
  }

  return {
    project_id: projectId,
    force,
    scanned: localFiles.length,
    skipped,
    added,
    updated,
    orphans: orphanFiles.length,
    orphan_files: orphanFiles,
    chunks_upserted: chunksUpserted,
    chunks_deleted: chunksDeleted,
    ms: Date.now() - started,
  };
}
