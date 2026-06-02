// Deterministic JSON serialization + SHA-256 helper.
//
// Used by the GLOBAL-vault export/import tools (Session 48 Phase 2) so a given
// vault state always serializes to a byte-identical file regardless of object
// key insertion order. See docs/superpowers/specs/2026-06-02-global-vault-
// export-import-design.md §2 (Determinism rules).
//
// Rules:
//   - Object keys are sorted recursively (lexicographic, by UTF-16 code unit —
//     the JS default String comparison). Arrays preserve their element order.
//   - `undefined` values (and object entries whose value is `undefined`) are
//     omitted, matching JSON.stringify semantics.
//   - Fixed 2-space indentation, `\n` newlines (Node's JSON.stringify default).
//   - No wall-clock or random input — purely a function of the value passed in.

import { createHash } from "node:crypto";

/**
 * Recursively rebuild `value` with every plain-object's keys sorted, so that
 * two structurally-equal values produce an identical canonical form. Arrays are
 * left in place (order is significant). `undefined` is dropped.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    // Primitives (string/number/boolean/null) pass through. `undefined` is
    // handled by the callers (array map below collapses it to null the same way
    // JSON.stringify does; object assembly skips undefined-valued keys).
    return value;
  }

  if (Array.isArray(value)) {
    // Preserve element order; canonicalize each element. JSON.stringify renders
    // an `undefined` array slot as `null`, so mirror that here.
    return value.map((el) => (el === undefined ? null : canonicalize(el)));
  }

  // Plain object: emit keys in sorted order, skipping undefined-valued entries.
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * Serialize `value` to a canonical, byte-stable JSON string: keys sorted
 * recursively, 2-space indent, `undefined` omitted. Equal data → equal output.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
