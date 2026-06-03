// M8.1 Phase 1 — Knowledge Graph Extractor (pure).
//
// Mines a primary node + secondary (FILE/DECISION) reference nodes/edges
// from a single memory_chunks row. Pure function — NO supabase, NO LLM,
// NO I/O. The graph daemon (src/graph/daemon.ts) is the only consumer.
//
// Design choices (locked):
//   * Skip rule: metadata.type === 'LOG' OR trimmed content < 20 chars.
//   * Primary node: type = metadata.type ?? 'NOTE'; label = sanitized
//     first non-empty line, capped at 200 chars; falls back to
//     `chunk:<id>` when no usable line exists. Carries embedding +
//     source_chunk_id so it anchors the chunk in kg_nodes.
//   * File-ref edges: regex over common code/doc extensions, dedupe,
//     cap at 10. Skip paths containing 'node_modules' or starting with
//     'http' (URL false-positives, not local files).
//   * Decision-ref edges: SCM-S<n>-D<i> pattern, dedupe, cap at 5,
//     skip primary's own decision_id to avoid self-loops downstream.
//   * sanitizeLabel: trim → collapse whitespace → strip leading
//     markdown bullets (`#`, `*`, `-`, ` `) → slice to max.
//
// Boundary Invariant: zero LLM imports. Verified by the boundary linter
// (scripts/lint-boundaries.ts) — although src/graph is not on the lint
// roots, we hold the invariant voluntarily so the daemon's promotion to
// a protected directory in future is a no-op.

import { sanitizeForExtraction, isGarbageLabel } from "./sanitize.js";

export type ExtractedNode = {
  type: string;
  label: string;
  properties: Record<string, unknown>;
  embedding?: number[] | null;
  source_chunk_id?: number | null;
};

export type ExtractedEdgeSpec = {
  source: { type: string; label: string };
  target: { type: string; label: string };
  relation: string;
  weight?: number;
  properties?: Record<string, unknown>;
};

export type ExtractionResult = {
  nodes: ExtractedNode[];
  edges: ExtractedEdgeSpec[];
  skipped: boolean;
  reason?: string;
};

const MIN_CONTENT_CHARS = 20;
const MAX_LABEL_LEN = 200;
const MAX_FILE_REFS = 10;
const MAX_DECISION_REFS = 5;
const MAX_SYMBOL_REFS = 15;

// Matches paths like `src/tools/kg.ts`, `scripts/020_knowledge_graph.sql`,
// `package.json`, etc. Extensions are the ones we actually want to
// index (code/docs/data). The leading `\b` keeps us from grabbing
// embedded substrings inside identifiers.
const FILE_REF_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|sql|md|py|json)\b/g;

// Sovereign Decision IDs: SCM-S<session>-D<index>.
const DECISION_RE = /SCM-S\d+-D\d+/g;

// Backticked code identifiers → SYMBOL nodes. These are author-flagged,
// high-signal entities; file-shaped and decision-shaped labels are deferred to
// their own producers (FILE_EXT_RE / DECISION_LABEL_RE) to avoid duplicate types.
const BACKTICK_RE = /`([^`]+)`/g;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?:\(\))?$/;
const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|sql|md|py|json)$/i;
const DECISION_LABEL_RE = /^SCM-S\d+-D\d+$/;

export function sanitizeLabel(s: string, max: number = MAX_LABEL_LEN): string {
  let out = String(s ?? "").trim();
  if (out.length === 0) return "";
  // Collapse internal whitespace runs (including tabs/newlines) to a single
  // space first, then strip leading markdown bullet/header characters in a
  // loop so we peel multiple layers ("# - item" → "item").
  out = out.replace(/\s+/g, " ");
  while (out.length > 0 && (out[0] === "#" || out[0] === "*" || out[0] === "-" || out[0] === " ")) {
    out = out.slice(1);
  }
  if (out.length > max) out = out.slice(0, max);
  return out;
}

// First line that yields a non-empty, non-garbage label — so a chunk that opens
// with a mermaid/blockquote scrap doesn't become a garbage primary node.
function firstProseLabel(s: string, max: number): string {
  for (const ln of String(s ?? "").split("\n")) {
    const label = sanitizeLabel(ln, max);
    if (label.length > 0 && !isGarbageLabel(label)) return label;
  }
  return "";
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function extractFromChunk(chunk: {
  id: number;
  content: string;
  metadata: Record<string, unknown> | null;
  embedding: number[] | null;
}): ExtractionResult {
  const meta = chunk.metadata ?? {};
  const metaType = typeof meta.type === "string" ? (meta.type as string) : null;
  const content = typeof chunk.content === "string" ? chunk.content : "";

  if (metaType === "LOG" || content.trim().length < MIN_CONTENT_CHARS) {
    return { nodes: [], edges: [], skipped: true, reason: "log_or_too_short" };
  }

  // Strip code/mermaid/table/HTML/blockquote syntax before any producer reads
  // the chunk, so structural fragments never become nodes (SCM-S50-D1).
  const text = sanitizeForExtraction(content);

  // ── Primary node ──────────────────────────────────────────────────────
  const primaryType = metaType ?? "NOTE";
  let primaryLabel = firstProseLabel(text, MAX_LABEL_LEN);
  if (primaryLabel.length === 0) primaryLabel = `chunk:${chunk.id}`;

  const primaryProps: Record<string, unknown> = {
    source_chunk_id: chunk.id,
  };
  if (typeof meta.status === "string") primaryProps.status = meta.status;

  const decMatch = text.match(/SCM-S\d+-D\d+/);
  if (decMatch) primaryProps.decision_id = decMatch[0];

  const primary: ExtractedNode = {
    type: primaryType,
    label: primaryLabel,
    properties: primaryProps,
    embedding: chunk.embedding ?? null,
    source_chunk_id: chunk.id,
  };

  const nodes: ExtractedNode[] = [primary];
  const edges: ExtractedEdgeSpec[] = [];

  // ── File-ref edges ────────────────────────────────────────────────────
  // Use matchAll so we can inspect the 2 chars preceding each match — that
  // lets us drop URL-like paths whose scheme part (`http://`) the regex
  // can't capture because `:` and `/` of the scheme are outside its
  // character class.
  const rawFileMatches: string[] = [];
  for (const m of text.matchAll(FILE_REF_RE)) {
    const idx = m.index ?? 0;
    const before2 = text.slice(Math.max(0, idx - 3), idx);
    if (before2.endsWith("://")) continue; // URL scheme prefix
    rawFileMatches.push(m[0]);
  }
  const filesDeduped = dedupe(rawFileMatches)
    .filter((p) => !p.includes("node_modules"))
    .filter((p) => !p.startsWith("http"))
    .filter((p) => !isGarbageLabel(p))
    .slice(0, MAX_FILE_REFS);

  for (const fpath of filesDeduped) {
    nodes.push({
      type: "FILE",
      label: fpath,
      properties: {},
    });
    edges.push({
      source: { type: primaryType, label: primaryLabel },
      target: { type: "FILE", label: fpath },
      relation: "MENTIONS",
      weight: 1.0,
    });
  }

  // ── Decision-ref edges ────────────────────────────────────────────────
  const decMatches = text.match(DECISION_RE) ?? [];
  const ownDecision = typeof primaryProps.decision_id === "string" ? (primaryProps.decision_id as string) : null;
  const decsDeduped = dedupe(decMatches)
    .filter((d) => d !== ownDecision)
    .filter((d) => !isGarbageLabel(d))
    .slice(0, MAX_DECISION_REFS);

  for (const dec of decsDeduped) {
    nodes.push({
      type: "DECISION",
      label: dec,
      properties: {},
    });
    edges.push({
      source: { type: primaryType, label: primaryLabel },
      target: { type: "DECISION", label: dec },
      relation: "REFERENCES",
      weight: 1.5,
    });
  }

  // ── Symbol-ref edges ──────────────────────────────────────────────────
  // Backticked identifiers are author-flagged, high-signal entities; the shared
  // (project_id, type, label) node bridges every chunk that mentions a symbol,
  // giving the graph enough density to re-rank. Defer file/decision shapes.
  const symbolLabels: string[] = [];
  for (const m of text.matchAll(BACKTICK_RE)) {
    const label = m[1].trim().replace(/\(\)$/, "");
    if (!IDENTIFIER_RE.test(label)) continue;
    if (FILE_EXT_RE.test(label)) continue;
    if (DECISION_LABEL_RE.test(label)) continue;
    if (isGarbageLabel(label)) continue;
    symbolLabels.push(label);
  }

  for (const sym of dedupe(symbolLabels).slice(0, MAX_SYMBOL_REFS)) {
    nodes.push({ type: "SYMBOL", label: sym, properties: {} });
    edges.push({
      source: { type: primaryType, label: primaryLabel },
      target: { type: "SYMBOL", label: sym },
      relation: "MENTIONS",
      weight: 1.0,
    });
  }

  return { nodes, edges, skipped: false };
}
