import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { chat } from "../ollama.js";

const DEFAULT_TARGET_TOKENS = 3000;
const BYTES_PER_TOKEN = 4;

export async function summarizeMemoryFile(args: {
  file_path: string;
  target_tokens?: number;
  dry_run?: boolean;
  llm_model?: string;
}) {
  const target = args.target_tokens ?? DEFAULT_TARGET_TOKENS;
  const name = basename(args.file_path);

  if (!/^(CLAUDE|MEMORY)\.md$/i.test(name)) {
    throw new Error(`Refusing to summarize ${name} — this tool only operates on CLAUDE.md or MEMORY.md.`);
  }

  const original = await readFile(args.file_path, "utf8");
  const originalTokens = Math.ceil(original.length / BYTES_PER_TOKEN);

  if (originalTokens <= target) {
    return {
      file: args.file_path,
      action: "no_change",
      original_tokens_estimated: originalTokens,
      target,
    };
  }

  const prompt = [
    {
      role: "system" as const,
      content:
        "You are compressing a project memory file for a Claude Code session. Preserve every actionable rule, invariant, decision, and pointer. Remove verbosity, repetition, background storytelling, and examples that can be regenerated on demand. Use compact bullet points and tables where they help. Keep markdown headings. Do not invent content. Emit the compressed file ONLY — no commentary, no code fences.",
    },
    {
      role: "user" as const,
      content:
        `Target size: ~${target} tokens (~${target * BYTES_PER_TOKEN} bytes).\n\n` +
        `Filename: ${name}\n\n--- BEGIN FILE ---\n${original}\n--- END FILE ---`,
    },
  ];

  const compressed = (await chat(prompt, { model: args.llm_model, temperature: 0.1, timeoutMs: 180_000 })).trim();
  const compressedTokens = Math.ceil(compressed.length / BYTES_PER_TOKEN);

  if (args.dry_run) {
    return {
      file: args.file_path,
      action: "dry_run",
      original_tokens_estimated: originalTokens,
      compressed_tokens_estimated: compressedTokens,
      target,
      preview: compressed.slice(0, 1500) + (compressed.length > 1500 ? "\n\n... (truncated) ..." : ""),
    };
  }

  await writeFile(args.file_path, compressed, "utf8");
  return {
    file: args.file_path,
    action: "written",
    original_tokens_estimated: originalTokens,
    compressed_tokens_estimated: compressedTokens,
    target,
    reduction_pct: Math.round(((originalTokens - compressedTokens) / originalTokens) * 100),
  };
}
