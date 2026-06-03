// src/graph/sanitize.ts — pure, no I/O, no LLM (Boundary Invariant #1).
// Two chokepoints for entity extraction: sanitize the INPUT, denylist the OUTPUT.

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const HTML_RE = /<[^>]+>/g;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{3,}/;
const MERMAID_LINE_RE = /-->|==>|\bgraph\s+(?:TD|LR|TB|RL|BT)\b|\bsubgraph\b/i;

/** Strip non-prose syntax so producers never see mermaid/code/table fragments. */
export function sanitizeForExtraction(content: string): string {
  const noBlocks = content.replace(FENCE_RE, " ").replace(HTML_RE, " ");
  return noBlocks
    .split("\n")
    .filter((l) => !TABLE_DELIM_RE.test(l))
    .filter((l) => !MERMAID_LINE_RE.test(l))
    .map((l) => l.replace(/^\s*>+\s?/, "")) // strip blockquote markers
    .join("\n");
}

// Shared by the TS extractor and the SQL purge script (kept in lockstep).
const STRUCTURAL_DENYLIST =
  /^(?:graph|subgraph|td|lr|tb|rl|bt|end|click|style|classdef|n\d+)$|-->|==>|["'\]\[]/i;

/** True when a produced label is a structural fragment, not a real entity. */
export function isGarbageLabel(label: string): boolean {
  const t = label.trim();
  return t.length < 3 || STRUCTURAL_DENYLIST.test(t);
}

// Postgres-flavored mirror of STRUCTURAL_DENYLIST for the purge script (Task 4).
export const GARBAGE_SQL_REGEX =
  "^(graph|subgraph|td|lr|tb|rl|bt|end|click|style|classdef|n[0-9]+)$|-->|==>|[\"'\\]\\[]";

/** JS-side parity check used by the purge predicate test. */
export function matchesGarbageSql(label: string): boolean {
  const t = label.trim();
  return t.length < 3 || new RegExp(GARBAGE_SQL_REGEX, "i").test(t);
}
