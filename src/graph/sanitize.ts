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

// Structural fragments to reject as node labels: mermaid keywords, node ids,
// arrows, and punctuation-dominant scraps (e.g.  s"]  or  [" ). Kept PRECISE so
// it is safe to run against primary labels, which are whole prose first-lines
// and routinely contain quotes/brackets.
const STRUCTURAL_KEYWORD = /^(?:graph|subgraph|td|lr|tb|rl|bt|end|click|style|classdef)$/i;
const MERMAID_NODE = /^n\d+$/i;
const MERMAID_ARROW = /-->|==>/;

/** True when a label is a structural fragment, not a real entity. */
export function isGarbageLabel(label: string): boolean {
  const t = label.trim();
  if (t.length < 3) return true;
  if (STRUCTURAL_KEYWORD.test(t)) return true;
  if (MERMAID_NODE.test(t)) return true;
  if (MERMAID_ARROW.test(t)) return true;
  // Fewer than two alphanumerics ⇒ punctuation-dominant scrap.
  if (t.replace(/[^A-Za-z0-9]/g, "").length < 2) return true;
  return false;
}
