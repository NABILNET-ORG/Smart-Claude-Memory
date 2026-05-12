// Boundary Invariant #1 lint fence — SCM-S22-D1 (backlog #117).
//
// Statically enforces: NO generative-AI imports or LLM HTTP endpoints inside
// src/sleep/** or src/curriculum/**. Daemons mine + stub only; generative
// reasoning is exclusively the Orchestrator's domain (Single Brain mandate).
//
// Forbidden:
//   - import / from "ollama"  or any relative path containing "/ollama"
//   - import / from "@anthropic-ai/..."
//   - import / from "openai" or "openai/..."
//   - import / from "@google/..."
//   - dynamic imports of any of the above
//   - string literals containing api.anthropic.com, api.openai.com,
//     generativelanguage.googleapis.com, or :11434 (Ollama default port)
//
// Exits 0 on clean scan, 1 on any match, 2 on unexpected error.
// Wired into `npm run build` via `npm run lint:boundaries && tsc`.

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";

const ROOTS = ["src/sleep", "src/curriculum"] as const;

type Rule = { name: string; regex: RegExp };

const IMPORT_RULES: Rule[] = [
  {
    name: "local ollama helper (relative import)",
    regex: /\bfrom\s+["']\.{1,2}\/(?:[^"']*\/)?ollama(?:\.js)?["']/g,
  },
  {
    name: "ollama npm package",
    regex: /\bfrom\s+["']ollama(?:["']|\/[^"']*["'])/g,
  },
  {
    name: "@anthropic-ai/* SDK",
    regex: /\bfrom\s+["']@anthropic-ai\/[^"']+["']/g,
  },
  {
    name: "openai SDK",
    regex: /\bfrom\s+["']openai(?:["']|\/[^"']*["'])/g,
  },
  {
    name: "@google/* SDK",
    regex: /\bfrom\s+["']@google\/[^"']+["']/g,
  },
  {
    name: "dynamic import — LLM package",
    regex:
      /\bimport\s*\(\s*["'](?:(?:[^"']*\/)?ollama(?:\.js)?|openai(?:\/[^"']*)?|@anthropic-ai\/[^"']+|@google\/[^"']+)["']\s*\)/g,
  },
];

const ENDPOINT_RULES: Rule[] = [
  { name: "Anthropic API endpoint", regex: /api\.anthropic\.com/g },
  { name: "OpenAI API endpoint", regex: /api\.openai\.com/g },
  { name: "Google Gemini endpoint", regex: /generativelanguage\.googleapis\.com/g },
  { name: "Ollama default port :11434", regex: /:11434\b/g },
];

type Violation = {
  file: string;
  line: number;
  rule: string;
  match: string;
};

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

async function scanFile(file: string, rules: Rule[]): Promise<Violation[]> {
  const content = await readFile(file, "utf8");
  const out: Violation[] = [];
  for (const { name, regex } of rules) {
    for (const m of content.matchAll(regex)) {
      out.push({
        file,
        line: lineOf(content, m.index ?? 0),
        rule: name,
        match: m[0],
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const repo = process.cwd();
  const allRules = [...IMPORT_RULES, ...ENDPOINT_RULES];

  const files: string[] = [];
  for (const root of ROOTS) {
    const matches = await glob(`${root}/**/*.{ts,tsx,js,mjs,cjs}`, {
      cwd: repo,
      absolute: true,
      nodir: true,
    });
    files.push(...matches);
  }

  if (files.length === 0) {
    console.warn(
      `[lint-boundaries] WARNING: no source files matched roots: ${ROOTS.join(", ")}. ` +
        "Did the layout change?",
    );
    process.exit(0);
  }

  const violations: Violation[] = [];
  for (const f of files) {
    violations.push(...(await scanFile(f, allRules)));
  }

  if (violations.length === 0) {
    console.log(
      `[lint-boundaries] OK — scanned ${files.length} file(s) under ${ROOTS.join(", ")}. ` +
        "Boundary Invariant #1 holds (no LLM imports, no LLM endpoints).",
    );
    process.exit(0);
  }

  console.error("");
  console.error("[lint-boundaries] FAIL — Boundary Invariant #1 violated.");
  console.error(
    `Forbidden: generative-AI imports or LLM fetch endpoints inside ${ROOTS.join(", ")}.`,
  );
  console.error(
    "Single Brain mandate (SCM-S22-D1): daemons mine + stub only; generation is " +
      "the Orchestrator's domain (compose_skill_candidate).",
  );
  console.error("");
  for (const v of violations) {
    // Strip Windows UNC long-path prefix that glob can emit ("\\?\C:\..."
    // or "//?/C:/...") so relative paths render cleanly on Win32.
    const native = v.file.replace(/^[\\/]{2}\?[\\/]/, "");
    const rel = path.relative(repo, native).replace(/\\/g, "/");
    console.error(`  ${rel}:${v.line}  [${v.rule}]  ${v.match}`);
  }
  console.error("");
  console.error(`Total violations: ${violations.length}`);
  console.error(
    "Fix by either (a) moving the generative call to an Orchestrator tool, or " +
      "(b) reverting the import. Daemons must remain LLM-free.",
  );
  console.error("");
  process.exit(1);
}

main().catch((e) => {
  console.error("[lint-boundaries] unexpected error:", e);
  process.exit(2);
});
