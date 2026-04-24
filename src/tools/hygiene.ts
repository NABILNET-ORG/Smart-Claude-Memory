import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export const HARD_LIMIT = 750;

// ─── exclusion list ──────────────────────────────────────────────────────
// Auto-generated files that should never be subject to the line limit.

const EXCLUDE_EXACT_BASENAMES = new Set([
  "types.ts", // Supabase-generated types
]);

const EXCLUDE_SUFFIXES = [
  ".arb", // Dart/Flutter localization bundles
  ".l10n.dart", // Flutter l10n outputs
  ".g.dart", // build_runner generated
  ".freezed.dart", // freezed generated
];

export function isExcluded(path: string): boolean {
  const name = basename(path);
  if (EXCLUDE_EXACT_BASENAMES.has(name)) return true;
  for (const suf of EXCLUDE_SUFFIXES) {
    if (name.toLowerCase().endsWith(suf)) return true;
  }
  return false;
}

// ─── refactor plan (static heuristic) ────────────────────────────────────

type SymbolKind = "function" | "class" | "type" | "interface" | "const" | "enum" | "other";
type Bucket = "main" | "types" | "utils" | "service";

export type ParsedSymbol = {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  start_line: number;
  end_line: number;
  lines: number;
  bucket: Bucket;
};

export type RefactorPlan = {
  needed: boolean;
  current_lines: number;
  target_limit: number;
  split_count: number;
  suggested_files: Array<{
    path: string;
    role: Bucket;
    contains: string[];
    estimated_lines: number;
  }>;
  imports_to_add: string[];
  notes: string[];
};

const LANG_PARSERS: Record<string, (text: string) => ParsedSymbol[]> = {
  ts: parseTypeScriptLike,
  tsx: parseTypeScriptLike,
  js: parseTypeScriptLike,
  jsx: parseTypeScriptLike,
  py: parsePython,
  dart: parseDart,
};

function extLang(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

function parseTypeScriptLike(text: string): ParsedSymbol[] {
  const lines = text.split(/\r?\n/);
  const re =
    /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
  const raw: Array<Omit<ParsedSymbol, "end_line" | "lines" | "bucket">> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line)) continue;
    const m = line.match(re);
    if (m) {
      const kindRaw = m[4];
      const kind: SymbolKind =
        kindRaw === "function" || kindRaw === "class" || kindRaw === "type" ||
        kindRaw === "interface" || kindRaw === "const" || kindRaw === "enum"
          ? kindRaw
          : "other";
      raw.push({ name: m[5], kind, exported: !!m[1], start_line: i + 1 });
    }
  }
  return finishSymbols(raw, lines.length);
}

function parsePython(text: string): ParsedSymbol[] {
  const lines = text.split(/\r?\n/);
  const re = /^(class|def|async\s+def)\s+([A-Za-z_][\w]*)/;
  const raw: Array<Omit<ParsedSymbol, "end_line" | "lines" | "bucket">> = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s/.test(lines[i])) continue;
    const m = lines[i].match(re);
    if (m) {
      raw.push({
        name: m[2],
        kind: m[1].startsWith("class") ? "class" : "function",
        exported: true,
        start_line: i + 1,
      });
    }
  }
  return finishSymbols(raw, lines.length);
}

function parseDart(text: string): ParsedSymbol[] {
  const lines = text.split(/\r?\n/);
  const re =
    /^(?:abstract\s+|final\s+|sealed\s+|mixin\s+|extension\s+)?(class|enum|mixin|typedef)\s+([A-Za-z_][\w]*)/;
  const fnRe = /^(?:static\s+|final\s+|const\s+)?(?:[\w<>?,\s]+\s+)?([A-Za-z_][\w]*)\s*\(/;
  const raw: Array<Omit<ParsedSymbol, "end_line" | "lines" | "bucket">> = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s/.test(lines[i])) continue;
    const line = lines[i];
    const mCls = line.match(re);
    if (mCls) {
      raw.push({
        name: mCls[2],
        kind: mCls[1] === "class" || mCls[1] === "mixin" ? "class" : "type",
        exported: true,
        start_line: i + 1,
      });
      continue;
    }
    const mFn = line.match(fnRe);
    if (mFn && !["if", "for", "while", "switch", "return"].includes(mFn[1])) {
      raw.push({ name: mFn[1], kind: "function", exported: true, start_line: i + 1 });
    }
  }
  return finishSymbols(raw, lines.length);
}

function finishSymbols(
  raw: Array<Omit<ParsedSymbol, "end_line" | "lines" | "bucket">>,
  totalLines: number,
): ParsedSymbol[] {
  return raw.map((s, i) => {
    const end = i + 1 < raw.length ? raw[i + 1].start_line - 1 : totalLines;
    return {
      ...s,
      end_line: end,
      lines: end - s.start_line + 1,
      bucket: classifyBucket(s.name, s.kind),
    };
  });
}

function classifyBucket(name: string, kind: SymbolKind): Bucket {
  if (kind === "type" || kind === "interface" || kind === "enum") return "types";
  const lower = name.toLowerCase();
  if (/(util|helper|format|parse|normalize|validate|convert|serialize|deserialize|transform|assert|sanitize)/.test(lower)) {
    return "utils";
  }
  if (/(service|manager|controller|handler|repository|store|provider|client|gateway|adapter)/.test(lower)) {
    return "service";
  }
  return "main";
}

export function planRefactor(path: string, text: string): RefactorPlan {
  const currentLines = text.split(/\r?\n/).length;
  const splitCount = Math.max(2, Math.ceil(currentLines / HARD_LIMIT));
  const target = HARD_LIMIT;

  const lang = extLang(path);
  const parser = LANG_PARSERS[lang];
  const base = basename(path, extname(path));
  const dir = dirname(path);
  const ext = extname(path);

  if (!parser) {
    return {
      needed: true,
      current_lines: currentLines,
      target_limit: target,
      split_count: splitCount,
      suggested_files: [],
      imports_to_add: [],
      notes: [
        `No symbol parser for '${lang}' files — provide the split plan manually.`,
        `Target: split ${currentLines}-line file into ~${splitCount} files, each ≤ ${target} lines.`,
      ],
    };
  }

  const symbols = parser(text);
  if (symbols.length === 0) {
    return {
      needed: true,
      current_lines: currentLines,
      target_limit: target,
      split_count: splitCount,
      suggested_files: [],
      imports_to_add: [],
      notes: [
        `Parser found no top-level symbols in ${basename(path)}. Likely a monolithic script — split by logical sections manually.`,
      ],
    };
  }

  // Group by bucket, then further subdivide any bucket exceeding the limit.
  const buckets: Record<Bucket, ParsedSymbol[]> = { main: [], types: [], utils: [], service: [] };
  for (const s of symbols) buckets[s.bucket].push(s);

  type Part = { role: Bucket; symbols: ParsedSymbol[]; lines: number };
  const parts: Part[] = [];
  const bucketOrder: Bucket[] = ["main", "service", "utils", "types"];
  for (const b of bucketOrder) {
    const group = buckets[b];
    if (group.length === 0) continue;
    let current: ParsedSymbol[] = [];
    let running = 0;
    for (const s of group) {
      if (running + s.lines > target && current.length > 0) {
        parts.push({ role: b, symbols: current, lines: running });
        current = [];
        running = 0;
      }
      current.push(s);
      running += s.lines;
    }
    if (current.length > 0) parts.push({ role: b, symbols: current, lines: running });
  }

  // Ensure at least splitCount parts. If heuristic produced fewer, sub-divide the biggest.
  while (parts.length < splitCount) {
    const biggest = parts
      .map((p, i) => ({ i, size: p.lines, count: p.symbols.length }))
      .filter((x) => x.count > 1)
      .sort((a, b) => b.size - a.size)[0];
    if (!biggest) break;
    const half = Math.floor(parts[biggest.i].symbols.length / 2);
    const left = parts[biggest.i].symbols.slice(0, half);
    const right = parts[biggest.i].symbols.slice(half);
    const leftLines = left.reduce((s, x) => s + x.lines, 0);
    const rightLines = right.reduce((s, x) => s + x.lines, 0);
    parts.splice(biggest.i, 1,
      { role: parts[biggest.i].role, symbols: left, lines: leftLines },
      { role: parts[biggest.i].role, symbols: right, lines: rightLines },
    );
  }

  const roleCounts: Record<Bucket, number> = { main: 0, types: 0, utils: 0, service: 0 };
  const suggested = parts.map((p) => {
    roleCounts[p.role] += 1;
    const n = roleCounts[p.role];
    const suffix = p.role === "main" ? "" : `.${p.role}`;
    const indexTag = n > 1 ? `.${n}` : "";
    const fileName = `${base}${suffix}${indexTag}${ext}`;
    return {
      path: join(dir, fileName).replace(/\\/g, "/"),
      role: p.role,
      contains: p.symbols.map((s) => s.name),
      estimated_lines: p.lines,
    };
  });

  const mainFile = suggested.find((s) => s.role === "main") ?? suggested[0];
  const importsToAdd = suggested
    .filter((s) => s !== mainFile)
    .map((s) => {
      const names = s.contains.slice(0, 6).join(", ") + (s.contains.length > 6 ? ", ..." : "");
      const rel = "./" + basename(s.path, ext);
      return `In ${basename(mainFile.path)}: import { ${names} } from "${rel}";`;
    });

  const notes = [
    `Heuristic split by name: types → *.types.*, utils/helpers → *.utils.*, service-layer → *.service.*.`,
    `Cross-file references inside the original are not computed — review and add imports between split files as needed.`,
    `Target: ${splitCount} files, each ≤ ${target} lines. Heuristic produced ${parts.length}.`,
  ];

  return {
    needed: true,
    current_lines: currentLines,
    target_limit: target,
    split_count: splitCount,
    suggested_files: suggested,
    imports_to_add: importsToAdd,
    notes,
  };
}

// ─── public API ──────────────────────────────────────────────────────────

export type HygieneStatus =
  | "ok"
  | "grandfathered"
  | "excluded"
  | "missing";

export type HygieneFile = {
  path: string;
  name: string;
  exists: boolean;
  lines: number;
  over_limit: boolean;
  grandfathered: boolean;
  excluded: boolean;
  split_count: number;
  status: HygieneStatus;
  refactor_plan?: RefactorPlan;
};

export async function checkCodeHygiene(args: { paths: string[] }): Promise<{
  limit: number;
  files: HygieneFile[];
  summary: { ok: number; grandfathered: number; excluded: number; over: number; missing: number };
}> {
  const limit = HARD_LIMIT;
  const summary = { ok: 0, grandfathered: 0, excluded: 0, over: 0, missing: 0 };

  const files: HygieneFile[] = await Promise.all(
    args.paths.map(async (p) => {
      const name = basename(p);
      try {
        await stat(p);
      } catch {
        summary.missing++;
        return {
          path: p,
          name,
          exists: false,
          lines: 0,
          over_limit: false,
          grandfathered: false,
          excluded: false,
          split_count: 0,
          status: "missing" as const,
        };
      }

      if (isExcluded(p)) {
        summary.excluded++;
        return {
          path: p,
          name,
          exists: true,
          lines: 0,
          over_limit: false,
          grandfathered: false,
          excluded: true,
          split_count: 0,
          status: "excluded" as const,
        };
      }

      const text = await readFile(p, "utf8");
      const lines = text.split(/\r?\n/).length;
      const overLimit = lines > limit;
      const splitCount = overLimit ? Math.max(2, Math.ceil(lines / limit)) : 1;

      if (overLimit) {
        summary.grandfathered++;
        summary.over++;
        const plan = planRefactor(p, text);
        return {
          path: p,
          name,
          exists: true,
          lines,
          over_limit: true,
          grandfathered: true,
          excluded: false,
          split_count: splitCount,
          status: "grandfathered" as const,
          refactor_plan: plan,
        };
      }

      summary.ok++;
      return {
        path: p,
        name,
        exists: true,
        lines,
        over_limit: false,
        grandfathered: false,
        excluded: false,
        split_count: 1,
        status: "ok" as const,
      };
    }),
  );

  return { limit, files, summary };
}
