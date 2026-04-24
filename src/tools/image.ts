import { readFile, stat, rm, mkdtemp } from "node:fs/promises";
import { resolve, extname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { captionImage, embed } from "../ollama.js";
import { upsertChunks, md5 } from "../supabase.js";
import { currentProjectId } from "../project.js";

// Formats Moondream's llama.cpp runner accepts natively.
const NATIVE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg"]);

const MAGIC_TABLE: Array<{ hex: string; ext: string }> = [
  { hex: "89504e47", ext: ".png" },
  { hex: "ffd8ff", ext: ".jpg" },
  { hex: "52494646", ext: ".webp" }, // also matches other RIFF containers; good enough for vision files
  { hex: "47494638", ext: ".gif" },
  { hex: "424d", ext: ".bmp" },
];

async function detectFormat(path: string): Promise<string> {
  const extHint = extname(path).toLowerCase();
  if (NATIVE_IMAGE_EXTS.has(extHint)) return extHint;
  // Magic-number sniff — defends against mislabeled extensions.
  const buf = await readFile(path);
  const head = buf.subarray(0, 12).toString("hex");
  for (const { hex, ext } of MAGIC_TABLE) {
    if (head.startsWith(hex)) return ext;
  }
  return extHint || ".bin";
}

/**
 * Convert any raster image to PNG via ffmpeg. Returns both the output PNG
 * path AND the unique mkdtemp directory so the caller can wipe the whole
 * directory in one recursive rm — no orphaned temp dirs.
 */
async function convertToPng(src: string): Promise<{ path: string; tempDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "claude-mem-img-"));
  const dest = join(dir, `${basename(src, extname(src))}.png`);
  try {
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1", dest],
      { stdio: "pipe" },
    );
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `ffmpeg conversion of ${basename(src)} → png failed: ${(e as Error).message}. ` +
        "Install ffmpeg and ensure it's on PATH, or pass a PNG/JPEG directly.",
    );
  }
  return { path: dest, tempDir: dir };
}

export async function indexImage(args: {
  image_path: string;
  caption_prompt?: string;
  project_id?: string;
  vision_model?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const abs = resolve(args.image_path);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`Not a file: ${abs}`);

  const fmt = await detectFormat(abs);
  let toCaption = abs;
  let tempDirToClean: string | null = null;
  let convertedFrom: string | null = null;

  if (!NATIVE_IMAGE_EXTS.has(fmt)) {
    convertedFrom = fmt;
    const converted = await convertToPng(abs);
    toCaption = converted.path;
    tempDirToClean = converted.tempDir;
  }

  try {
    const caption = await captionImage(toCaption, args.caption_prompt, {
      model: args.vision_model,
    });
    if (!caption.trim()) throw new Error("Vision model returned an empty caption.");

    const [vec] = await embed([caption]);
    const fileHash = md5(caption);

    await upsertChunks(projectId, [
      {
        content: caption,
        file_origin: abs,
        chunk_index: 0,
        embedding: vec,
        file_hash: fileHash,
        metadata: {
          type: "image",
          image_path: abs,
          bytes: info.size,
          caption_chars: caption.length,
          source_format: fmt,
          converted_from: convertedFrom,
        },
      },
    ]);

    return {
      action: "index_image",
      project_id: projectId,
      image_path: abs,
      source_format: fmt,
      converted_to_png: convertedFrom !== null,
      caption_chars: caption.length,
      caption_preview: caption.slice(0, 300),
    };
  } finally {
    // Total Surgical Wipe — delete the unique mkdtemp directory recursively,
    // which also removes the PNG inside. No orphaned temp artefacts.
    if (tempDirToClean) {
      await rm(tempDirToClean, { recursive: true, force: true }).catch(() => {});
    }
  }
}
