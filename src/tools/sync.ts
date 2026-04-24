import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import archiver from "archiver";
import { memoryRoots } from "../config.js";
import { chunkMarkdown } from "../chunker.js";
import { embed } from "../ollama.js";
import {
  upsertChunks,
  listFileHashes,
  deleteChunksForFile,
  verifyFileSynced,
  md5,
  type ChunkRow,
} from "../supabase.js";
import { currentProjectId } from "../project.js";

const BATCH_SIZE = 100;

// Files that must NEVER be deleted, even if they match the scan pattern.
// Case-insensitive comparison on basename.
const NEVER_DELETE = new Set([
  "claude.md",
  "memory.md",
  "readme.md",
  "license",
  "license.md",
  "license.txt",
  "changelog",
  "changelog.md",
]);

function isProtected(file: string): boolean {
  return NEVER_DELETE.has(basename(file).toLowerCase());
}

type GitStatus = { inRepo: boolean; clean: boolean };

// execFileSync (no shell) — safe against path injection because `git` is the program
// and each arg is passed as argv, not interpolated into a command line.
function gitStatus(dir: string): GitStatus {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe" });
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { inRepo: true, clean: out.trim() === "" };
  } catch {
    return { inRepo: false, clean: false };
  }
}

// Resolve backups/ at the package root. Works for both src/tools/sync.ts (tsx)
// and dist/tools/sync.js (compiled) — both resolve to ../../ = package root.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backupRoot = resolve(packageRoot, "backups");

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
  purge?: PurgeResult;
  summary?: string;
};

type PurgeResult =
  | {
      mode: "dry_run";
      would_delete: number;
      files: string[];
      protected_skipped: string[];
      note: string;
    }
  | {
      mode: "aborted";
      reason: "not_all_files_verified" | "git_unsafe";
      details: Record<string, unknown>;
    }
  | {
      mode: "committed";
      deleted: number;
      protected_skipped: string[];
      backup_zip: string;
      manifest: string;
      verified_files: number;
      delete_failures?: Array<{ file: string; error: string }>;
    };

export async function syncLocalMemory(
  args: {
    roots?: string[];
    project_id?: string;
    force?: boolean;
    auto_purge?: boolean;
    confirm?: boolean;
  } = {},
): Promise<SyncResult> {
  const started = Date.now();
  const projectId = args.project_id ?? currentProjectId;
  const roots = args.roots?.length ? args.roots : memoryRoots;
  const force = Boolean(args.force);

  const existing = await listFileHashes(projectId);

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

  let skipped = 0;
  let added = 0;
  let updated = 0;
  let chunksUpserted = 0;
  let chunksDeleted = 0;
  const buffer: ChunkRow[] = [];
  const syncedHashes = new Map<string, string>();

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
    syncedHashes.set(file, hash);
    const prior = existing.get(file);

    if (!force && prior === hash) {
      skipped++;
      continue;
    }

    const isUpdate = prior !== undefined;
    if (isUpdate) {
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

  const orphanFiles: string[] = [];
  for (const fileInDb of existing.keys()) {
    if (!localSet.has(fileInDb)) orphanFiles.push(fileInDb);
  }

  const result: SyncResult = {
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

  if (args.auto_purge) {
    result.purge = await runPurge({
      projectId,
      syncedHashes,
      confirm: Boolean(args.confirm),
      roots,
    });
  }

  result.summary = buildSummary(result);
  return result;
}

async function runPurge(opts: {
  projectId: string;
  syncedHashes: Map<string, string>;
  confirm: boolean;
  roots: string[];
}): Promise<PurgeResult> {
  const purgeCandidates = [...opts.syncedHashes.keys()].filter((f) => !isProtected(f));
  const protectedSkipped = [...opts.syncedHashes.keys()].filter(isProtected);

  if (!opts.confirm) {
    return {
      mode: "dry_run",
      would_delete: purgeCandidates.length,
      files: purgeCandidates,
      protected_skipped: protectedSkipped,
      note:
        "DRY RUN — no files deleted. Re-call with auto_purge: true AND confirm: true to commit.",
    };
  }

  // Surface git state without blocking — the backup ZIP is the real safety net.
  const dirtyRepos: string[] = [];
  const notInGit: string[] = [];
  for (const root of opts.roots) {
    const s = gitStatus(root);
    if (!s.inRepo) notInGit.push(root);
    else if (!s.clean) dirtyRepos.push(root);
  }

  // Verify every candidate round-trips against Supabase under the expected file_hash.
  const unverified: string[] = [];
  let verifiedCount = 0;
  for (const f of purgeCandidates) {
    const hash = opts.syncedHashes.get(f)!;
    const rows = await verifyFileSynced(opts.projectId, f, hash);
    if (rows === 0) unverified.push(f);
    else verifiedCount++;
  }
  if (unverified.length > 0) {
    return {
      mode: "aborted",
      reason: "not_all_files_verified",
      details: {
        unverified,
        verified_count: verifiedCount,
        message:
          "Aborted before any delete — Supabase does not have matching (project_id, file_origin, file_hash) rows for every file. Retry sync or investigate before purging.",
      },
    };
  }

  // All-or-nothing backup ZIP, written BEFORE any deletion.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupRoot, `${stamp}-${opts.projectId}`);
  await mkdir(dir, { recursive: true });
  const zipPath = join(dir, "purge-backup.zip");

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", rejectPromise);
    output.on("close", () => resolvePromise());
    archive.pipe(output);
    (async () => {
      for (const f of purgeCandidates) {
        const content = await readFile(f, "utf8");
        const entryName = f.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/").replace(/^\/+/, "");
        archive.append(content, { name: entryName });
      }
      archive.finalize();
    })().catch(rejectPromise);
  });

  const manifestPath = join(dir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        stamp,
        project_id: opts.projectId,
        file_count: purgeCandidates.length,
        files: purgeCandidates.map((f) => ({ path: f, hash: opts.syncedHashes.get(f) })),
        git_dirty_roots: dirtyRepos,
        roots_not_in_git: notInGit,
      },
      null,
      2,
    ),
  );

  // Delete after backup is durable.
  let deleted = 0;
  const deleteFailures: Array<{ file: string; error: string }> = [];
  for (const f of purgeCandidates) {
    try {
      await rm(f, { force: true });
      deleted++;
    } catch (e) {
      deleteFailures.push({ file: f, error: (e as Error).message });
    }
  }

  const committed: PurgeResult = {
    mode: "committed",
    deleted,
    protected_skipped: protectedSkipped,
    backup_zip: zipPath,
    manifest: manifestPath,
    verified_files: verifiedCount,
  };
  if (deleteFailures.length > 0) committed.delete_failures = deleteFailures;
  return committed;
}

function buildSummary(r: SyncResult): string {
  const purged = r.purge?.mode === "committed" ? r.purge.deleted : 0;
  const chunks = r.chunks_upserted;
  let tail = ".";
  if (r.purge?.mode === "dry_run") tail = ` (dry-run: ${r.purge.would_delete} files would be deleted)`;
  else if (r.purge?.mode === "aborted") tail = ` (purge aborted: ${r.purge.reason})`;
  return `Context Optimized: ${chunks} chunks synced, ${purged} files purged${tail}`;
}
