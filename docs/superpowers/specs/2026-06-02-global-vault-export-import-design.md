# Global Brain Export — GLOBAL Vault deterministic Export/Import (Session 48 Phase 2)

Status: **PROPOSED — awaiting user approval before any backend code.**
Scope: GLOBAL vault only (`project_id = 'GLOBAL'`), per the Session 48 goal.

## 1. Problem & constraints

Export the reserved **GLOBAL** Knowledge Vault (`memory_chunks` rows where
`project_id='GLOBAL'`) to a **portable, purely deterministic** JSON package, and
import it into another SCM instance **without overriding local data**.

Hard facts from recon (drive the design):
- `memory_chunks` columns: `id` (bigserial PK), `content`, `embedding vector(768)`,
  `file_origin`, `chunk_index`, `content_hash` (MD5 of content), `metadata jsonb`
  (`is_global`, `global_rationale`, `type`…), `file_hash`, `updated_at`, `project_id`.
  **No `created_at`, no `source`.**
- UNIQUE / dedupe key: `(project_id, file_origin, chunk_index)`.
- Embeddings are **not** reproducible bit-for-bit across Ollama/model versions →
  **ship embeddings inside the package** (no re-embedding at import).
- `upsertChunks()` overwrites on conflict → **cannot** be reused for "no override";
  a dedicated importer is required.
- No canonical-JSON utility exists → add a small key-sorted serializer.

## 2. Determinism rules (the core requirement)

A given vault state always serializes to a **byte-identical** file:
1. **Stable ordering:** chunks sorted by `(content_hash, file_origin, chunk_index)`.
2. **Volatile fields excluded:** never emit `id`, `updated_at`, or `project_id`
   (DB-local / time-based / constant). The importer assigns its own.
3. **Canonical JSON:** object keys sorted recursively (incl. `metadata`), fixed
   2-space indentation, `\n` newlines.
4. **No wall-clock / random fields anywhere** in the payload.
5. **Integrity digest:** `content_digest = sha256(canonicalJSON(chunks[]))` — a pure
   function of vault content, independent of SCM version.

## 3. Package schema — `format: "scm-global-vault"`, `format_version: "1.0.0"`

```jsonc
{
  "format": "scm-global-vault",
  "format_version": "1.0.0",
  "scope": "GLOBAL",
  "embedding": { "model": "nomic-embed-text", "dim": 768 },
  "generator": { "tool": "smart-claude-memory", "version": "2.3.2" },
  "count": 123,
  "content_digest": "sha256:<hex over canonicalJSON(chunks)>",
  "chunks": [
    {
      "content_hash": "<md5 of content>",
      "content": "<full text>",
      "file_origin": "<origin label>",
      "chunk_index": 0,
      "metadata": { "is_global": true, "global_rationale": "...", "type": "PATTERN" },
      "embedding": [/* 768 float4 values, as stored */]
    }
  ]
}
```

Field table:

| Field | Meaning | Determinism |
|-------|---------|-------------|
| `format` / `format_version` | identity + semver of the package format | constant |
| `scope` | always `GLOBAL` (this phase) | constant |
| `embedding.model` / `.dim` | compatibility gate on import | constant |
| `generator.version` | informational only; **excluded from `content_digest`** | n/a |
| `count` | `chunks.length` | derived |
| `content_digest` | `sha256(canonicalJSON(chunks))` | content-only |
| `chunks[]` | sorted, canonical, volatile-free | fully deterministic |

## 4. Export algorithm — `export_global_vault`

`export_global_vault({ out_path?, pretty? = true })`
1. Query **all** GLOBAL rows incl. `embedding` + `content_hash` (new query — the
   existing `listGlobalPatterns` omits both). Normalize `embedding` to `number[]`.
2. Strip volatile fields; sort by `(content_hash, file_origin, chunk_index)`.
3. `content_digest = sha256(canonicalJSON(chunks))`; assemble envelope.
4. Write `canonicalJSON(package)` to `out_path`
   (default `~/.claude-memory/exports/global-vault.json`).
5. Return `{ ok, path, scope:"GLOBAL", count, content_digest, bytes, embed_model, embed_dim }`.
   (Embeddings make this large → written to a **file**, not returned inline.)

## 5. Import algorithm — `import_global_vault` (no-override, idempotent)

`import_global_vault({ in_path, dry_run? = false, on_embed_mismatch? = "abort" })`
1. Read + validate: `format`, major `format_version`, `embedding.dim === EMBED_DIM`
   and model match → else apply `on_embed_mismatch` (`abort` | `skip` | `allow`).
2. **Verify** `content_digest` against recomputed `sha256(canonicalJSON(chunks))`.
3. Load local GLOBAL state once: a Set of existing `content_hash`, and a Set of
   existing `(file_origin, chunk_index)` keys.
4. For each package chunk (sorted order):
   - `content_hash` already local → **skip** (`skipped_existing`) — idempotent.
   - else `(file_origin, chunk_index)` already local → **skip** (`skipped_conflict`)
     — honors *no override* (never replace local).
   - else → stage INSERT (and add hash+key to the in-memory sets).
5. If `dry_run` → return the ledger only (pure read, no write). Else `.insert()` the
   staged rows into `project_id='GLOBAL'` (plain insert; conflicts pre-filtered).
6. Return ledger: `{ ok, scope:"GLOBAL", digest_verified, total_in_package,
   inserted, skipped_existing, skipped_conflict, embed_compat }`.

**Guarantees:** re-importing the same package = all `skipped_existing` (idempotent);
existing local GLOBAL rows are never modified or deleted; result is a pure function
of (package, local state) → deterministic.

## 6. New code (built only after approval)

- `src/canonical-json.ts` — `canonicalJSON(value)` recursive key-sorted serializer + `sha256()` helper.
- `src/tools/global-vault-export.ts` — `exportGlobalVault()` handler + query.
- `src/tools/global-vault-import.ts` — `importGlobalVault()` handler + merge logic.
- `src/index.ts` — register `export_global_vault` + `import_global_vault` (58 → 60 tools).
- `tests/global-vault.test.ts` — round-trip determinism, digest verify, no-override
  skips, idempotent re-import, embed-mismatch policy, dry_run.

## 7. Out of scope (this phase)

Per-project (non-GLOBAL) export; cross-dimension re-embedding; encryption/signing;
streaming for very large vaults; UI surface. Embeddings shipped inline (no re-embed).

## 8. Acceptance criteria

1. Two exports of an unchanged vault are **byte-identical**.
2. `content_digest` verifies on import; tampering is detected.
3. Import never updates/deletes a local GLOBAL row; re-import is a no-op.
4. `dry_run` writes nothing and returns an accurate ledger.
5. `npm run build` + full test suite green; new tests cover the above.
