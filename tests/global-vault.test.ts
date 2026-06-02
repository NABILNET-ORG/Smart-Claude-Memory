// Tests for the deterministic GLOBAL-vault export/import tools
// (Session 48 Phase 2):
//   - src/canonical-json.ts
//   - src/tools/global-vault-export.ts
//   - src/tools/global-vault-import.ts
//
// Hermetic: ../src/supabase.js and ../src/config.js are stubbed via Node's
// `mock.module` (--experimental-test-module-mocks) so NO Supabase round-trip
// and NO .env are required. A controllable fake query builder records inserts
// and proves that upsert/update are NEVER called (the no-override contract).
//
// Runtime: node:test + node:assert/strict, loaded via tsx.

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Mock state ──────────────────────────────────────────────────────────────
// `selectRows` is the data returned for the FIRST (and only) page of any
// .select(...).eq(...).range(...) chain. Tests set it before invoking a handler.
// We always return a short page (< PAGE_SIZE 1000) so paging terminates.
type SelectRow = Record<string, unknown>;

const dbState: {
  selectRows: SelectRow[];
  selectError: { message: string } | null;
  insertError: { message: string } | null;
  insertedRows: SelectRow[][];
  insertCalls: number;
  upsertCalls: number;
  updateCalls: number;
  deleteCalls: number;
  lastSelectColumns: string | null;
  lastTable: string | null;
} = {
  selectRows: [],
  selectError: null,
  insertError: null,
  insertedRows: [],
  insertCalls: 0,
  upsertCalls: 0,
  updateCalls: 0,
  deleteCalls: 0,
  lastSelectColumns: null,
  lastTable: null,
};

function resetDb(): void {
  dbState.selectRows = [];
  dbState.selectError = null;
  dbState.insertError = null;
  dbState.insertedRows = [];
  dbState.insertCalls = 0;
  dbState.upsertCalls = 0;
  dbState.updateCalls = 0;
  dbState.deleteCalls = 0;
  dbState.lastSelectColumns = null;
  dbState.lastTable = null;
}

// A chainable query-builder fake. .select()/.eq() return `this`; .range() is the
// awaited terminal for reads and resolves { data, error }. .insert() resolves
// { error } directly. upsert/update/delete are tracked so we can assert they're
// never used by the importer.
function makeQueryBuilder(table: string) {
  dbState.lastTable = table;
  const builder: Record<string, unknown> = {
    select(columns?: string) {
      dbState.lastSelectColumns = columns ?? null;
      return builder;
    },
    eq() {
      return builder;
    },
    order() {
      return builder;
    },
    range() {
      // Terminal for reads.
      return Promise.resolve({
        data: dbState.selectError ? null : dbState.selectRows,
        error: dbState.selectError,
      });
    },
    insert(rows: SelectRow[]) {
      dbState.insertCalls += 1;
      dbState.insertedRows.push(rows);
      return Promise.resolve({ error: dbState.insertError });
    },
    upsert() {
      dbState.upsertCalls += 1;
      return Promise.resolve({ error: null });
    },
    update() {
      dbState.updateCalls += 1;
      return builder;
    },
    delete() {
      dbState.deleteCalls += 1;
      return builder;
    },
  };
  return builder;
}

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from(table: string) {
        return makeQueryBuilder(table);
      },
    },
  },
});

mock.module("../src/config.js", {
  namedExports: {
    config: {
      OLLAMA_EMBED_MODEL: "nomic-embed-text",
      EMBED_DIM: 768,
    },
  },
});

// Import the units AFTER the mocks are registered.
const { canonicalJSON, sha256Hex } = await import("../src/canonical-json.js");
const { exportGlobalVault } = await import("../src/tools/global-vault-export.js");
const { importGlobalVault } = await import("../src/tools/global-vault-import.js");

// ── Fixtures ────────────────────────────────────────────────────────────────
// Embeddings are tiny (3-dim) on purpose; the export/import code never inspects
// dimension beyond the config gate, and a small vector keeps the file readable.
function makeRows() {
  return [
    {
      content: "beta content",
      embedding: [0.4, 0.5, 0.6],
      file_origin: "b.md",
      chunk_index: 0,
      content_hash: "hash-beta",
      metadata: { type: "PATTERN", is_global: true },
    },
    {
      content: "alpha content",
      embedding: [0.1, 0.2, 0.3],
      file_origin: "a.md",
      chunk_index: 1,
      content_hash: "hash-alpha",
      metadata: { is_global: true, type: "DECISION" },
    },
  ];
}

async function tmpFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scm-vault-"));
  return path.join(dir, name);
}

// Read a written package and return its parsed form.
async function readPackage(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, "utf8"));
}

beforeEach(() => {
  resetDb();
});

// ── (a) canonical-json ──────────────────────────────────────────────────────
describe("canonicalJSON", () => {
  it("is independent of object key insertion order", () => {
    const a = { b: 1, a: { y: 2, x: 3 }, c: [3, 2, 1] };
    const b = { c: [3, 2, 1], a: { x: 3, y: 2 }, b: 1 };
    assert.equal(canonicalJSON(a), canonicalJSON(b));
  });

  it("preserves array element order", () => {
    assert.equal(canonicalJSON([3, 1, 2]), "[\n  3,\n  1,\n  2\n]");
  });

  it("omits undefined-valued keys", () => {
    assert.equal(canonicalJSON({ a: undefined, b: 1 }), "{\n  \"b\": 1\n}");
  });

  it("produces a stable sha256 digest for equal data", () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    assert.equal(sha256Hex(canonicalJSON(a)), sha256Hex(canonicalJSON(b)));
  });
});

// ── (b) export determinism ──────────────────────────────────────────────────
describe("exportGlobalVault — determinism", () => {
  it("two exports of fixed rows are byte-identical and sorted, volatile-free", async () => {
    const out1 = await tmpFile("v1.json");
    const out2 = await tmpFile("v2.json");

    dbState.selectRows = makeRows();
    const r1 = await exportGlobalVault({ out_path: out1 });
    dbState.selectRows = makeRows();
    const r2 = await exportGlobalVault({ out_path: out2 });

    const buf1 = await readFile(out1, "utf8");
    const buf2 = await readFile(out2, "utf8");
    assert.equal(buf1, buf2, "two exports must be byte-identical");

    assert.equal(r1.content_digest, r2.content_digest);
    assert.equal(r1.ok, true);
    assert.equal(r1.scope, "GLOBAL");
    assert.equal(r1.count, 2);
    assert.equal(r1.embed_model, "nomic-embed-text");
    assert.equal(r1.embed_dim, 768);
    assert.ok(r1.content_digest.startsWith("sha256:"));

    const pkg = await readPackage(out1);
    assert.equal(pkg.format, "scm-global-vault");
    assert.equal(pkg.format_version, "1.0.0");

    // Sorted by content_hash → hash-alpha before hash-beta.
    const chunks = pkg.chunks as Array<Record<string, unknown>>;
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.content_hash, "hash-alpha");
    assert.equal(chunks[1]!.content_hash, "hash-beta");

    // Volatile fields must be absent on every chunk.
    for (const c of chunks) {
      assert.ok(!("id" in c), "id must be excluded");
      assert.ok(!("updated_at" in c), "updated_at must be excluded");
      assert.ok(!("project_id" in c), "project_id must be excluded");
      assert.ok(Array.isArray(c.embedding), "embedding present as array");
    }
  });

  it("normalizes a pgvector string embedding into a number[]", async () => {
    const out = await tmpFile("vstr.json");
    dbState.selectRows = [
      {
        content: "x",
        embedding: "[0.11,0.22,0.33]",
        file_origin: "x.md",
        chunk_index: 0,
        content_hash: "hash-x",
        metadata: {},
      },
    ];
    await exportGlobalVault({ out_path: out });
    const pkg = await readPackage(out);
    const chunks = pkg.chunks as Array<Record<string, unknown>>;
    assert.deepEqual(chunks[0]!.embedding, [0.11, 0.22, 0.33]);
  });

  it("digest matches a manual recompute over the canonical chunks", async () => {
    const out = await tmpFile("vdigest.json");
    dbState.selectRows = makeRows();
    const r = await exportGlobalVault({ out_path: out });
    const pkg = await readPackage(out);
    const manual = `sha256:${sha256Hex(canonicalJSON(pkg.chunks))}`;
    assert.equal(r.content_digest, manual);
    assert.equal(pkg.content_digest, manual);
  });
});

// ── (c) import no-override classification ────────────────────────────────────
describe("importGlobalVault — no-override classification", () => {
  // Build a valid on-disk package from the fixture rows.
  async function writeValidPackage(file: string): Promise<void> {
    const out = await tmpFile("export-src.json");
    dbState.selectRows = makeRows();
    await exportGlobalVault({ out_path: out });
    const content = await readFile(out, "utf8");
    await writeFile(file, content, "utf8");
    resetDb(); // clear export-side state so import starts clean
  }

  it("content_hash present locally → skipped_existing; key taken → skipped_conflict; fresh → inserted; upsert/update never called", async () => {
    const pkgPath = await tmpFile("pkg.json");
    await writeValidPackage(pkgPath);

    // Local state: hash-alpha already present (existing), and (b.md,0) slot
    // taken by a DIFFERENT content_hash (conflict for the package's hash-beta).
    dbState.selectRows = [
      { content_hash: "hash-alpha", file_origin: "a.md", chunk_index: 1 },
      { content_hash: "some-other-hash", file_origin: "b.md", chunk_index: 0 },
    ];

    const res = await importGlobalVault({ in_path: pkgPath });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.digest_verified, true);
    assert.equal(res.total_in_package, 2);
    assert.equal(res.skipped_existing, 1); // hash-alpha
    assert.equal(res.skipped_conflict, 1); // hash-beta blocked by (b.md,0)
    assert.equal(res.inserted, 0);

    // Nothing fresh → no insert; and NEVER upsert/update (no-override contract).
    assert.equal(dbState.insertCalls, 0);
    assert.equal(dbState.upsertCalls, 0);
    assert.equal(dbState.updateCalls, 0);
  });

  it("fresh chunks are inserted via plain insert (not upsert)", async () => {
    const pkgPath = await tmpFile("pkg2.json");
    await writeValidPackage(pkgPath);

    // Empty local GLOBAL state → both chunks are fresh.
    dbState.selectRows = [];

    const res = await importGlobalVault({ in_path: pkgPath });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.inserted, 2);
    assert.equal(res.skipped_existing, 0);
    assert.equal(res.skipped_conflict, 0);

    assert.equal(dbState.insertCalls, 1, "one batch insert");
    assert.equal(dbState.upsertCalls, 0, "upsert must never be called");
    assert.equal(dbState.updateCalls, 0, "update must never be called");

    // Row payload assertions: project_id GLOBAL, file_hash populated, content_hash md5.
    const batch = dbState.insertedRows[0]!;
    assert.equal(batch.length, 2);
    for (const row of batch) {
      assert.equal(row.project_id, "GLOBAL");
      assert.ok(typeof row.content_hash === "string" && row.content_hash.length === 32);
      assert.ok(typeof row.file_hash === "string" && row.file_hash.length > 0);
      assert.ok(typeof row.updated_at === "string");
      assert.ok(Array.isArray(row.embedding));
    }
  });
});

// ── (d) idempotent re-import ─────────────────────────────────────────────────
describe("importGlobalVault — idempotency", () => {
  it("re-import with all content_hashes already local → inserted:0, all skipped_existing", async () => {
    // Export then read the package's own content_hashes so the simulated local
    // state exactly mirrors a prior successful import.
    const out = await tmpFile("exp.json");
    dbState.selectRows = makeRows();
    await exportGlobalVault({ out_path: out });
    const pkg = await readPackage(out);
    const chunks = pkg.chunks as Array<Record<string, unknown>>;
    resetDb();

    // Local state = every package chunk already present (by content_hash + key).
    dbState.selectRows = chunks.map((c) => ({
      content_hash: c.content_hash,
      file_origin: c.file_origin,
      chunk_index: c.chunk_index,
    }));

    const res = await importGlobalVault({ in_path: out });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.inserted, 0);
    assert.equal(res.skipped_existing, chunks.length);
    assert.equal(res.skipped_conflict, 0);
    assert.equal(dbState.insertCalls, 0);
  });
});

// ── (e) digest tamper ────────────────────────────────────────────────────────
describe("importGlobalVault — integrity", () => {
  it("a tampered chunk (digest mismatch) is rejected", async () => {
    const out = await tmpFile("tamper.json");
    dbState.selectRows = makeRows();
    await exportGlobalVault({ out_path: out });
    resetDb();

    const pkg = await readPackage(out);
    const chunks = pkg.chunks as Array<Record<string, unknown>>;
    chunks[0]!.content = "TAMPERED — digest no longer matches";
    const tamperPath = await tmpFile("tampered-pkg.json");
    // Write with canonical serializer so only `content` changed, not formatting.
    await writeFile(tamperPath, canonicalJSON(pkg), "utf8");

    const res = await importGlobalVault({ in_path: tamperPath });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /digest mismatch/i);
    assert.equal(dbState.insertCalls, 0);
  });

  it("ENOENT on a missing file returns ok:false with a reason", async () => {
    const res = await importGlobalVault({ in_path: path.join(os.tmpdir(), "does-not-exist-xyz.json") });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /not found/i);
  });

  it("an unrecognized format is rejected", async () => {
    const bad = await tmpFile("bad-format.json");
    await writeFile(bad, JSON.stringify({ format: "something-else", chunks: [] }), "utf8");
    const res = await importGlobalVault({ in_path: bad });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /format/i);
  });
});

// ── (f) embedding compatibility gate ─────────────────────────────────────────
describe("importGlobalVault — embedding compatibility", () => {
  async function writePackageWithEmbedding(
    file: string,
    embedding: { model: string; dim: number },
  ): Promise<void> {
    // Start from a real export, then override the embedding descriptor. The
    // digest is over chunks only, so changing embedding.{model,dim} does NOT
    // invalidate it — exactly the case the gate must catch independently.
    const out = await tmpFile("emb-src.json");
    dbState.selectRows = makeRows();
    await exportGlobalVault({ out_path: out });
    const pkg = await readPackage(out);
    pkg.embedding = embedding;
    await writeFile(file, canonicalJSON(pkg), "utf8");
    resetDb();
  }

  it("dimension mismatch is always fatal (even with on_embed_mismatch=allow)", async () => {
    const p = await tmpFile("dim.json");
    await writePackageWithEmbedding(p, { model: "nomic-embed-text", dim: 1024 });
    const res = await importGlobalVault({ in_path: p, on_embed_mismatch: "allow" });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /dim/i);
    assert.equal(dbState.insertCalls, 0);
  });

  it("model mismatch with default policy (abort) → ok:false", async () => {
    const p = await tmpFile("model-abort.json");
    await writePackageWithEmbedding(p, { model: "some-other-model", dim: 768 });
    const res = await importGlobalVault({ in_path: p });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /model/i);
  });

  it("model mismatch with policy=skip → no-op ledger, embed model_match:false", async () => {
    const p = await tmpFile("model-skip.json");
    await writePackageWithEmbedding(p, { model: "some-other-model", dim: 768 });
    const res = await importGlobalVault({ in_path: p, on_embed_mismatch: "skip" });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.inserted, 0);
    assert.equal(res.embed_compat.dim_match, true);
    assert.equal(res.embed_compat.model_match, false);
    assert.equal(dbState.insertCalls, 0);
  });

  it("model mismatch with policy=allow → proceeds and inserts fresh chunks", async () => {
    const p = await tmpFile("model-allow.json");
    await writePackageWithEmbedding(p, { model: "some-other-model", dim: 768 });
    dbState.selectRows = []; // empty local → both fresh
    const res = await importGlobalVault({ in_path: p, on_embed_mismatch: "allow" });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.inserted, 2);
    assert.equal(res.embed_compat.model_match, false);
    assert.equal(dbState.insertCalls, 1);
    assert.equal(dbState.upsertCalls, 0);
  });
});

// ── (g) dry_run ──────────────────────────────────────────────────────────────
describe("importGlobalVault — dry_run", () => {
  it("dry_run returns an accurate ledger and writes nothing", async () => {
    const out = await tmpFile("dry.json");
    dbState.selectRows = makeRows();
    await exportGlobalVault({ out_path: out });
    resetDb();

    dbState.selectRows = []; // empty local → both would be fresh
    const res = await importGlobalVault({ in_path: out, dry_run: true });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.dry_run, true);
    assert.equal(res.digest_verified, true);
    assert.equal(res.total_in_package, 2);
    assert.equal(res.inserted, 0); // dry run never inserts
    assert.equal(res.skipped_existing, 0);
    assert.equal(res.skipped_conflict, 0);
    assert.equal(dbState.insertCalls, 0, "dry_run must not insert");
    assert.equal(dbState.upsertCalls, 0);
  });
});
