// src/db/pg-adapter.ts — plain-PostgreSQL drop-in for the supabase-js subset
// the codebase actually uses. Backed by a single long-lived `pg.Pool`.
//
// Why this exists: the Sovereign Memory protocol no longer depends on the
// Supabase HTTP stack — it talks to a plain PostgreSQL 17 + pgvector database
// directly. To keep the blast radius at exactly one line, this module exposes
// the EXACT shape `src/supabase.ts` consumed from `createClient(...)`:
//
//   • `.from(table)` → a THENABLE PostgREST-style query builder. `await chain`
//     resolves to `{ data, error, count }`. It NEVER throws on a DB error —
//     the error is surfaced as `{ message, code }` so every existing
//     `if (error) throw …` guard keeps working unchanged.
//   • `.rpc(fn, args)` → `Promise<{ data, error }>` via `SELECT * FROM fn(named := $n …)`.
//     Result shape is inferred from PostgreSQL's own row shape:
//       – RETURNS TABLE / SETOF (≥2 cols, or >1 row)      → array of row objects
//       – RETURNS scalar (1 col, 1 row)                    → the unwrapped scalar
//       – RETURNS jsonb / composite (1 col, 1 row, object) → the unwrapped object
//
// Vectors: callers pass `number[]`. Anywhere a `number[]` is bound (insert /
// upsert / update value, or an rpc arg) it is serialized to a pgvector literal
// string `'[a,b,c]'` and cast to `extensions.vector` at the placeholder, so it
// lands correctly in `vector(768)` columns and vector-typed function args.
//
// Identifiers are always double-quoted; values are always parameterized with
// $1,$2,… No string interpolation of caller data ever reaches the SQL text.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import pg from "pg";

// Load .env on import so SUPABASE_POOLER_URL / SUPABASE_DB_URL are populated even
// when this module is imported in isolation (e.g. by a test that pulls in
// `../src/supabase.js` directly). The previous supabase-js implementation got
// this for free because `supabase.ts` imported `./config.js`, which runs
// dotenv at load; we preserve that exact behavior here. `quiet` + idempotent
// dotenv means a second load (config.ts also loads it) is harmless.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "..", "..", ".env"), quiet: true });

const { Pool, types } = pg;

// PostgREST (the stack supabase-js spoke to) serializes int8/bigint columns as
// JSON numbers, and every call site in this repo treats ids as `number`
// (`data.id`, `Number(r.id)`, numeric comparisons). node-postgres defaults to
// returning int8 as a STRING to avoid precision loss past 2^53. Our ids are
// bigserial sequence values that stay well within Number.MAX_SAFE_INTEGER, so
// we restore the PostgREST contract by parsing OID 20 (int8) to a JS number.
// OID 1700 (numeric) is intentionally left as text — it is used for arbitrary-
// precision values and never read numerically by id-style call sites.
types.setTypeParser(20, (val: string | null) => (val === null ? null : Number(val)));

// PostgREST returned timestamp/timestamptz/date columns as ISO-8601 TEXT, and
// call sites compare them by value (`assert.equal(a.decided_at, b.created_at)`)
// and round-trip them through `new Date(...)`. node-postgres instead parses
// them into JS Date objects (millisecond precision, reference-unequal even when
// equal — so `===` always fails, and microseconds are lost). Worse, the same
// timestamp reached two ways (a raw column vs. a jsonb-encoded RPC field) would
// stringify in two different formats. We restore PostgREST's single ISO-8601
// text contract so every timestamp — column or jsonb — compares equal:
//   "2026-06-25 07:33:57.961531+00" → "2026-06-25T07:33:57.961531+00:00"
// Microsecond precision is preserved and `new Date(str)` still parses it.
function pgTimestamptzToIso(val: string | null): string | null {
  if (val === null) return null;
  let s = val.replace(" ", "T");
  // Normalize the trailing tz offset: +HH / -HH → +HH:00 ; +HHMM → +HH:MM.
  // Anchored to a real time component (requires the 'T' we just inserted) so a
  // bare date like "2026-06-25" is never mistaken for an offset.
  const m = s.match(/T.*([+-])(\d{2})(?::?(\d{2}))?$/);
  if (m) {
    const sign = m[1];
    const hh = m[2];
    const mm = m[3] ?? "00";
    const offIdx = s.lastIndexOf(m[1]);
    s = s.slice(0, offIdx) + `${sign}${hh}:${mm}`;
  }
  return s;
}
types.setTypeParser(1184, pgTimestamptzToIso); // timestamptz
types.setTypeParser(1114, pgTimestamptzToIso); // timestamp (no tz)
types.setTypeParser(1082, (val: string | null) => val); // date — raw YYYY-MM-DD

// ─── pgvector type handling ───────────────────────────────────────────────
//
// node-postgres returns `vector` columns as text (e.g. "[1,0,...]") because the
// type is not in its built-in oid table — that's exactly what the existing
// `parseVector()` helper already tolerates, so no special parser is registered.
// Detection of array values is purely numeric: a value is a vector literal only
// when it is a non-empty array of finite numbers.

function isNumberArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

/** Serialize a number[] to a pgvector literal: [1,2,3] → "[1,2,3]". */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ─── shared pool ──────────────────────────────────────────────────────────

let sharedPool: pg.Pool | null = null;

function resolveConnectionString(): string {
  const conn = process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
  if (!conn) {
    throw new Error(
      "pg-adapter: SUPABASE_POOLER_URL or SUPABASE_DB_URL must be set",
    );
  }
  return conn;
}

function getPool(): pg.Pool {
  if (sharedPool) return sharedPool;
  const connectionString = resolveConnectionString();
  // Local Postgres (supabase start / Docker / 127.0.0.1) does not speak SSL;
  // cloud poolers require it. Mirror scripts/apply-schema.ts:38-42.
  const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString);
  sharedPool = new Pool({
    connectionString,
    ssl: isLocalDb ? false : { rejectUnauthorized: false },
  });
  // A pooled client emitting 'error' while idle must not crash the process.
  sharedPool.on("error", () => {
    /* swallowed — surfaced per-query as { error } instead */
  });
  return sharedPool;
}

/** Close the shared pool (tests / graceful shutdown). Idempotent. */
export async function closePgPool(): Promise<void> {
  if (!sharedPool) return;
  const p = sharedPool;
  sharedPool = null;
  await p.end();
}

// ─── result envelope types (byte-compatible with the supabase-js subset) ───

export interface PgError {
  message: string;
  code?: string;
}

export interface QueryResult<T = Record<string, unknown>> {
  data: T[] | T | null;
  error: PgError | null;
  count: number | null;
}

export interface RpcResult<T = unknown> {
  data: T;
  error: PgError | null;
}

function quoteIdent(name: string): string {
  // Reject embedded double-quotes defensively; table/column identifiers in this
  // codebase are always literals, never user input.
  return `"${String(name).replace(/"/g, '""')}"`;
}

function normalizeError(err: unknown): PgError {
  const e = err as { message?: unknown; code?: unknown };
  const message =
    typeof e?.message === "string" ? e.message : String(err ?? "unknown error");
  const code = typeof e?.code === "string" ? e.code : undefined;
  return code ? { message, code } : { message };
}

// ─── filter model ─────────────────────────────────────────────────────────
//
// Each operator method appends a predicate. Predicates are rendered to SQL at
// execution time so placeholder numbering ($1,$2,…) is assigned in one pass.

type Predicate = (bind: (value: unknown) => string) => string;

interface OrderSpec {
  column: string;
  ascending: boolean;
}

// ─── column-type awareness ────────────────────────────────────────────────
//
// INSERT/UPDATE/UPSERT must bind each value according to its DESTINATION column
// type, because node-postgres serializes a JS array to a Postgres array literal
// `{…}` — correct for native `text[]`/`bigint[]` columns but invalid for `jsonb`
// (which then errors `invalid input syntax for type json`). PostgREST hid this
// by accepting JSON and casting server-side; we recover the same correctness by
// learning column types once per table from information_schema and binding:
//   • jsonb            → JSON.stringify(value)::jsonb
//   • vector           → pgvector literal ::extensions.vector
//   • native array     → raw JS array (node-pg array-literalizes it)
//   • everything else  → raw scalar
type ColumnKind = "jsonb" | "vector" | "array" | "scalar";
type ColumnTypes = Map<string, ColumnKind>;

const columnTypeCache = new Map<string, ColumnTypes>();

async function loadColumnTypes(table: string): Promise<ColumnTypes> {
  const cached = columnTypeCache.get(table);
  if (cached) return cached;
  const types: ColumnTypes = new Map();
  try {
    const res = await getPool().query(
      `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    for (const row of res.rows as { column_name: string; data_type: string; udt_name: string }[]) {
      let kind: ColumnKind = "scalar";
      if (row.data_type === "jsonb" || row.data_type === "json") kind = "jsonb";
      else if (row.udt_name === "vector") kind = "vector";
      else if (row.data_type === "ARRAY") kind = "array";
      types.set(row.column_name, kind);
    }
    columnTypeCache.set(table, types);
  } catch {
    // Introspection failed (e.g. missing relation) — return empty so binding
    // falls back to the value-shape heuristic and the real query surfaces the
    // genuine error (42P01 etc.) instead of a masked introspection error.
  }
  return types;
}

/**
 * Bind a value to a placeholder. When `colTypes`+`column` are known, the
 * destination column type drives serialization; otherwise a value-shape
 * heuristic applies (number[] → vector, object/non-number-array → jsonb).
 */
function makeBinder(
  params: unknown[],
  colTypes?: ColumnTypes,
): (value: unknown, column?: string) => string {
  return (value: unknown, column?: string): string => {
    const kind = column ? colTypes?.get(column) : undefined;

    if (kind === "vector") {
      params.push(isNumberArray(value) ? toVectorLiteral(value) : value);
      return `$${params.length}::extensions.vector`;
    }
    if (kind === "jsonb") {
      params.push(value === null ? null : JSON.stringify(value));
      return `$${params.length}::jsonb`;
    }
    if (kind === "array") {
      params.push(value); // node-pg serializes JS arrays to Postgres array literals
      return `$${params.length}`;
    }
    if (kind === "scalar") {
      params.push(value);
      return `$${params.length}`;
    }

    // ── No column-type info → value-shape heuristic ──
    if (isNumberArray(value)) {
      params.push(toVectorLiteral(value));
      return `$${params.length}::extensions.vector`;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !Array.isArray(value)
    ) {
      // Plain object with no column hint → assume jsonb.
      params.push(JSON.stringify(value));
      return `$${params.length}::jsonb`;
    }
    params.push(value);
    return `$${params.length}`;
  };
}

class QueryBuilder<T = Record<string, unknown>>
  implements PromiseLike<QueryResult<T>>
{
  private readonly table: string;
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";

  // select
  private selectColumns = "*";
  private wantCount = false;
  private headOnly = false;

  // write payloads
  private insertRows: Record<string, unknown>[] = [];
  private updatePatch: Record<string, unknown> = {};
  private upsertConflict: string[] = [];

  // shared
  private predicates: Predicate[] = [];
  private orders: OrderSpec[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private returnRows = false; // .select() chained after insert/update/upsert/delete
  private singleRow = false; // exactly one row else PGRST116
  private maybeSingleRow = false; // 0→null, 1→obj, >1→error

  // Destination column types for the target table, loaded lazily before write
  // builds so values bind according to jsonb / vector / native-array / scalar.
  private colTypes: ColumnTypes | undefined;

  constructor(table: string) {
    this.table = table;
  }

  // ── projection ──────────────────────────────────────────────────────────

  select(
    columns = "*",
    opts?: { count?: "exact"; head?: boolean },
  ): this {
    // `.select()` after a write turns it into a RETURNING projection.
    if (this.op === "select") {
      this.selectColumns = columns || "*";
    } else {
      this.returnRows = true;
      this.selectColumns = columns || "*";
    }
    if (opts?.count === "exact") this.wantCount = true;
    if (opts?.head) {
      this.headOnly = true;
      this.returnRows = false;
    }
    return this;
  }

  // ── writes ──────────────────────────────────────────────────────────────

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = "insert";
    this.insertRows = Array.isArray(values) ? values : [values];
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.op = "update";
    this.updatePatch = patch;
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string },
  ): this {
    this.op = "upsert";
    this.insertRows = Array.isArray(values) ? values : [values];
    this.upsertConflict = opts?.onConflict
      ? opts.onConflict.split(",").map((c) => c.trim()).filter(Boolean)
      : [];
    return this;
  }

  delete(opts?: { count?: "exact" }): this {
    this.op = "delete";
    if (opts?.count === "exact") this.wantCount = true;
    return this;
  }

  // ── filters ─────────────────────────────────────────────────────────────

  eq(column: string, value: unknown): this {
    this.predicates.push((bind) => `${quoteIdent(column)} = ${bind(value)}`);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.predicates.push((bind) => `${quoteIdent(column)} <> ${bind(value)}`);
    return this;
  }

  gt(column: string, value: unknown): this {
    this.predicates.push((bind) => `${quoteIdent(column)} > ${bind(value)}`);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.predicates.push((bind) => `${quoteIdent(column)} >= ${bind(value)}`);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.predicates.push((bind) => `${quoteIdent(column)} < ${bind(value)}`);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.predicates.push((bind) => `${quoteIdent(column)} <= ${bind(value)}`);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.predicates.push((bind) => {
      if (!values || values.length === 0) return "false"; // IN () ≡ no match
      const placeholders = values.map((v) => bind(v)).join(", ");
      return `${quoteIdent(column)} IN (${placeholders})`;
    });
    return this;
  }

  is(column: string, value: null | boolean): this {
    this.predicates.push(() => {
      if (value === null) return `${quoteIdent(column)} IS NULL`;
      return `${quoteIdent(column)} IS ${value ? "TRUE" : "FALSE"}`;
    });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    const op = operator.toLowerCase();
    this.predicates.push((bind) => {
      if (op === "is" && value === null) {
        return `${quoteIdent(column)} IS NOT NULL`;
      }
      if (op === "is") {
        return `${quoteIdent(column)} IS NOT ${value ? "TRUE" : "FALSE"}`;
      }
      if (op === "in") {
        // supabase-js passes the IN list as a raw "(a,b,c)" string here.
        if (Array.isArray(value)) {
          if (value.length === 0) return "true";
          const placeholders = value.map((v) => bind(v)).join(", ");
          return `${quoteIdent(column)} NOT IN (${placeholders})`;
        }
        const raw = String(value).trim();
        const inner = raw.replace(/^\(/, "").replace(/\)$/, "").trim();
        if (inner.length === 0) return "true"; // NOT IN () ≡ everything
        return `${quoteIdent(column)} NOT IN (${inner})`;
      }
      if (op === "eq") return `${quoteIdent(column)} <> ${bind(value)}`;
      throw new Error(`pg-adapter: unsupported .not() operator "${operator}"`);
    });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.predicates.push((bind) => `${quoteIdent(column)} ILIKE ${bind(pattern)}`);
    return this;
  }

  like(column: string, pattern: string): this {
    this.predicates.push((bind) => `${quoteIdent(column)} LIKE ${bind(pattern)}`);
    return this;
  }

  contains(column: string, value: Record<string, unknown> | unknown[]): this {
    this.predicates.push((bind) => {
      // jsonb containment: col @> $n::jsonb
      const json = JSON.stringify(value);
      // Bind the JSON text directly (not via vector-aware binder).
      return `${quoteIdent(column)} @> ${bindJson(bind, json)}`;
    });
    return this;
  }

  /**
   * PostgREST `.or("col.eq.X,col.eq.Y")` — only the `eq` operator is used in
   * this codebase, so we parse exactly that grammar into an OR-group:
   *   "project_id.eq.A,project_id.eq.GLOBAL" → (project_id = $1 OR project_id = $2)
   */
  or(filterString: string): this {
    const clauses = filterString
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.predicates.push((bind) => {
      const parts: string[] = [];
      for (const clause of clauses) {
        const firstDot = clause.indexOf(".");
        const secondDot = clause.indexOf(".", firstDot + 1);
        if (firstDot < 0 || secondDot < 0) {
          throw new Error(`pg-adapter: malformed .or() clause "${clause}"`);
        }
        const col = clause.slice(0, firstDot);
        const operator = clause.slice(firstDot + 1, secondDot);
        const value = clause.slice(secondDot + 1);
        if (operator !== "eq") {
          throw new Error(
            `pg-adapter: .or() supports only eq, got "${operator}" in "${clause}"`,
          );
        }
        parts.push(`${quoteIdent(col)} = ${bind(value)}`);
      }
      return parts.length > 1 ? `(${parts.join(" OR ")})` : (parts[0] ?? "true");
    });
    return this;
  }

  // ── ordering / paging ─────────────────────────────────────────────────────

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: opts?.ascending !== false });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    // Inclusive on both ends (PostgREST semantics): LIMIT (to-from+1) OFFSET from.
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }

  // ── terminal row-count modifiers ──────────────────────────────────────────

  single(): this {
    this.singleRow = true;
    if (this.op !== "select") this.returnRows = true;
    return this;
  }

  maybeSingle(): this {
    this.maybeSingleRow = true;
    if (this.op !== "select") this.returnRows = true;
    return this;
  }

  // ── SQL assembly ──────────────────────────────────────────────────────────

  private buildWhere(params: unknown[]): string {
    if (this.predicates.length === 0) return "";
    const bind = makeBinder(params);
    const rendered = this.predicates.map((p) => p(bind));
    return ` WHERE ${rendered.join(" AND ")}`;
  }

  private buildOrderLimit(): string {
    let sql = "";
    if (this.orders.length > 0) {
      const cols = this.orders
        .map((o) => `${quoteIdent(o.column)} ${o.ascending ? "ASC" : "DESC"}`)
        .join(", ");
      sql += ` ORDER BY ${cols}`;
    }
    if (this.limitN !== null) sql += ` LIMIT ${Number(this.limitN)}`;
    if (this.offsetN !== null) sql += ` OFFSET ${Number(this.offsetN)}`;
    return sql;
  }

  private buildSelect(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const cols = this.headOnly && this.wantCount ? "" : this.selectColumns;
    if (this.wantCount) {
      // One round-trip: window COUNT(*) OVER () rides along with the rows.
      // For head:true we ask for zero rows but still get the total.
      const where = this.buildWhere(params);
      if (this.headOnly) {
        const text =
          `SELECT count(*)::bigint AS __scm_count FROM ${quoteIdent(this.table)}${where}`;
        return { text, params };
      }
      const select = cols === "*" ? "*" : cols;
      const text =
        `SELECT ${select}, count(*) OVER ()::bigint AS __scm_count ` +
        `FROM ${quoteIdent(this.table)}${where}${this.buildOrderLimit()}`;
      return { text, params };
    }
    const where = this.buildWhere(params);
    const text =
      `SELECT ${cols} FROM ${quoteIdent(this.table)}${where}${this.buildOrderLimit()}`;
    return { text, params };
  }

  private collectColumns(rows: Record<string, unknown>[]): string[] {
    const set = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) set.add(k);
    return [...set];
  }

  private buildInsert(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const bind = makeBinder(params, this.colTypes);
    const columns = this.collectColumns(this.insertRows);
    const colSql = columns.map(quoteIdent).join(", ");
    const valuesSql = this.insertRows
      .map(
        (row) =>
          `(${columns
            .map((c) => (c in row ? bind(row[c], c) : "DEFAULT"))
            .join(", ")})`,
      )
      .join(", ");

    let text = `INSERT INTO ${quoteIdent(this.table)} (${colSql}) VALUES ${valuesSql}`;

    if (this.op === "upsert") {
      if (this.upsertConflict.length > 0) {
        const conflictCols = this.upsertConflict.map(quoteIdent).join(", ");
        const updateCols = columns.filter(
          (c) => !this.upsertConflict.includes(c),
        );
        if (updateCols.length === 0) {
          text += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
        } else {
          const setSql = updateCols
            .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
            .join(", ");
          text += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setSql}`;
        }
      } else {
        text += " ON CONFLICT DO NOTHING";
      }
    }

    if (this.returnRows || this.singleRow || this.maybeSingleRow) {
      text += ` RETURNING ${this.selectColumns}`;
    }
    return { text, params };
  }

  private buildUpdate(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const bind = makeBinder(params, this.colTypes);
    const sets = Object.keys(this.updatePatch)
      .map((c) => `${quoteIdent(c)} = ${bind(this.updatePatch[c], c)}`)
      .join(", ");
    const where = this.buildWhere(params);
    let text = `UPDATE ${quoteIdent(this.table)} SET ${sets}${where}`;
    if (this.returnRows || this.singleRow || this.maybeSingleRow) {
      text += ` RETURNING ${this.selectColumns}`;
    }
    return { text, params };
  }

  private buildDelete(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const where = this.buildWhere(params);
    let text = `DELETE FROM ${quoteIdent(this.table)}${where}`;
    if (this.returnRows || this.singleRow || this.maybeSingleRow) {
      text += ` RETURNING ${this.selectColumns}`;
    }
    return { text, params };
  }

  private build(): { text: string; params: unknown[] } {
    switch (this.op) {
      case "insert":
      case "upsert":
        return this.buildInsert();
      case "update":
        return this.buildUpdate();
      case "delete":
        return this.buildDelete();
      default:
        return this.buildSelect();
    }
  }

  // ── execution ─────────────────────────────────────────────────────────────

  private async exec(): Promise<QueryResult<T>> {
    // Writes need destination column types so values bind as jsonb / vector /
    // native-array / scalar correctly. Loaded once per table, then cached.
    if (this.op === "insert" || this.op === "update" || this.op === "upsert") {
      this.colTypes = await loadColumnTypes(this.table);
    }

    let text: string;
    let params: unknown[];
    try {
      ({ text, params } = this.build());
    } catch (err) {
      return { data: null, error: normalizeError(err), count: null };
    }

    let rows: Record<string, unknown>[];
    let pgRowCount: number;
    try {
      const res = await getPool().query(text, params as unknown[]);
      rows = res.rows as Record<string, unknown>[];
      pgRowCount = res.rowCount ?? rows.length;
    } catch (err) {
      const error = normalizeError(err);
      return { data: null, error, count: null };
    }

    // ── derive count ──
    // For DELETE/UPDATE the affected-row tally is the driver rowCount (the
    // statement has no synthetic __scm_count column). For SELECT the count rides
    // along as a window column (or a dedicated COUNT(*) when head:true).
    let count: number | null = null;
    if (this.op === "delete" || this.op === "update") {
      count = this.wantCount ? pgRowCount : null;
    } else if (this.wantCount) {
      if (this.headOnly) {
        count = rows.length > 0 ? Number(rows[0].__scm_count) : 0;
      } else if (rows.length > 0 && "__scm_count" in rows[0]) {
        count = Number(rows[0].__scm_count);
      } else {
        // No rows matched — count is genuinely 0.
        count = 0;
      }
      // Strip the synthetic column from every row.
      for (const r of rows) delete r.__scm_count;
    }

    // ── head:true → never return rows ──
    if (this.headOnly) {
      return { data: null, error: null, count };
    }

    // ── single() ──
    if (this.singleRow) {
      if (rows.length === 1) {
        return { data: rows[0] as T, error: null, count };
      }
      return {
        data: null,
        error: {
          message: `JSON object requested, multiple (or no) rows returned (got ${rows.length})`,
          code: "PGRST116",
        },
        count,
      };
    }

    // ── maybeSingle() ──
    if (this.maybeSingleRow) {
      if (rows.length === 0) return { data: null, error: null, count };
      if (rows.length === 1) return { data: rows[0] as T, error: null, count };
      return {
        data: null,
        error: {
          message: `JSON object requested, multiple rows returned (got ${rows.length})`,
          code: "PGRST116",
        },
        count,
      };
    }

    // ── bare insert/upsert/delete/update without .select() → no data ──
    if (
      (this.op === "insert" ||
        this.op === "upsert" ||
        this.op === "delete" ||
        this.op === "update") &&
      !this.returnRows
    ) {
      return { data: null, error: null, count };
    }

    return { data: rows as T[], error: null, count };
  }

  // Memoize execution so the builder is single-shot: awaiting it (or attaching
  // .then/.catch/.finally more than once) runs the SQL exactly one time. Without
  // this, `await x` followed by any further `.then` would re-issue the query.
  private settled: Promise<QueryResult<T>> | null = null;
  private run(): Promise<QueryResult<T>> {
    if (!this.settled) this.settled = this.exec();
    return this.settled;
  }

  // PromiseLike: `await builder` runs the query.
  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<QueryResult<T> | TResult> {
    return this.run().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): PromiseLike<QueryResult<T>> {
    return this.run().finally(onfinally);
  }
}

/** Bind a JSON string as `$n::jsonb` without triggering vector detection. */
function bindJson(bind: (v: unknown) => string, json: string): string {
  // `bind` pushes the param and returns `$n` (string is never a number[]),
  // then we append the ::jsonb cast.
  const placeholder = bind(json);
  return `${placeholder}::jsonb`;
}

// ─── rpc result shaping ─────────────────────────────────────────────────────
//
// PostgREST's `.rpc()` response shape is decided by the FUNCTION's signature,
// not by the row/column count of a particular result — and that distinction is
// load-bearing here. A single-column set-returning function (e.g.
// `clustering_discover_projects() RETURNS TABLE(project_id text)`) yields an
// ARRAY OF OBJECTS `[{project_id:…}]`, whereas a scalar function
// (`increment_daemon_bucket() RETURNS int`) yields the bare value `5`. Both
// produce one column at the wire level, so we must consult `pg_proc.proretset`
// to tell them apart. Cached per function name (functions don't change shape
// at runtime).
interface FnMeta {
  setReturning: boolean; // proretset — TABLE/SETOF vs scalar/single
}
const fnMetaCache = new Map<string, FnMeta>();

async function loadFnMeta(fnName: string): Promise<FnMeta | null> {
  const cached = fnMetaCache.get(fnName);
  if (cached) return cached;
  try {
    const res = await getPool().query(
      `SELECT p.proretset
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = $1 AND n.nspname = 'public'
        LIMIT 1`,
      [fnName],
    );
    if (res.rows.length === 0) return null;
    const meta: FnMeta = { setReturning: Boolean(res.rows[0].proretset) };
    fnMetaCache.set(fnName, meta);
    return meta;
  } catch {
    return null;
  }
}

// ─── rpc ──────────────────────────────────────────────────────────────────

async function rpc<T = unknown>(
  fnName: string,
  args: Record<string, unknown> = {},
): Promise<RpcResult<T>> {
  const params: unknown[] = [];
  const namedArgs: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue; // skip → let SQL DEFAULTs apply
    if (isNumberArray(value)) {
      params.push(toVectorLiteral(value));
      namedArgs.push(`${quoteIdent(key)} := $${params.length}::extensions.vector`);
    } else if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date)
    ) {
      // jsonb args (e.g. p_metadata_filter / p_metadata).
      params.push(JSON.stringify(value));
      namedArgs.push(`${quoteIdent(key)} := $${params.length}::jsonb`);
    } else {
      params.push(value);
      namedArgs.push(`${quoteIdent(key)} := $${params.length}`);
    }
  }

  // Learn the function's return kind BEFORE running so we shape the result the
  // way PostgREST did. (Looked up once, then cached.)
  const meta = await loadFnMeta(fnName);

  const text = `SELECT * FROM ${quoteIdent(fnName)}(${namedArgs.join(", ")})`;

  let res: pg.QueryResult;
  try {
    res = await getPool().query(text, params as unknown[]);
  } catch (err) {
    return { data: null as unknown as T, error: normalizeError(err) };
  }

  const rows = res.rows as Record<string, unknown>[];
  const fields = res.fields ?? [];

  // ── set-returning (RETURNS TABLE / SETOF) → ALWAYS an array of row objects ──
  // This holds even for a single-column TABLE function, where unwrapping to
  // scalars would silently break callers that read `row.<col>` (e.g.
  // discoverProjects over clustering_discover_projects). Mirrors PostgREST.
  if (meta?.setReturning) {
    return { data: rows as unknown as T, error: null };
  }

  // ── scalar / single-composite (NOT set-returning) → unwrap the lone value ──
  // `RETURNS int` → the number; `RETURNS jsonb`/composite → the single object.
  // Multi-column composite with no proretset still unwraps to one row object.
  if (!meta) {
    // No metadata (introspection failed / function not in public): fall back to
    // a structural guess that preserves the common cases.
    if (fields.length <= 1) {
      const colName = fields[0]?.name;
      const valueOf = (r: Record<string, unknown>): unknown =>
        colName ? r[colName] : Object.values(r)[0];
      if (rows.length === 0) return { data: null as unknown as T, error: null };
      if (rows.length === 1) return { data: valueOf(rows[0]) as T, error: null };
      return { data: rows.map(valueOf) as unknown as T, error: null };
    }
    return { data: (rows[0] ?? null) as unknown as T, error: null };
  }

  if (rows.length === 0) return { data: null as unknown as T, error: null };
  if (fields.length <= 1) {
    const colName = fields[0]?.name;
    const v = colName ? rows[0][colName] : Object.values(rows[0])[0];
    return { data: v as T, error: null };
  }
  // Single composite row (e.g. RECORD/OUT params) → the row object itself.
  return { data: rows[0] as unknown as T, error: null };
}

// ─── client surface ─────────────────────────────────────────────────────────
//
// The PUBLIC await-shape intentionally types `data` loosely (`any`). This is not
// laziness — it mirrors supabase-js's behavior when no generated Database types
// are supplied: row payloads come back untyped so every existing call site
// (`data.id`, `data.status`, `for (const r of data)`, `data.map(...)`,
// `data.length`) type-checks exactly as it did under `createClient(...)`. The
// strict generics live INSIDE the implementation (`QueryResult<T>`); only the
// boundary is widened so the swap is byte-compatible for all 41 importers.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * Resolved envelope for a row-set chain (`select` / filters with no
 * `.single()`). `data` is `Any[]` so `.map`, iteration, `.length`, and
 * indexing all type-check exactly as supabase-js's untyped `T[]` did.
 */
export interface PgAwaited {
  data: Any[] | null;
  error: PgError | null;
  count: number | null;
}

/**
 * Resolved envelope after `.single()` / `.maybeSingle()`. `data` is a single
 * record (`Any`) so property access (`data.id`, `data.status`) type-checks.
 */
export interface PgAwaitedSingle {
  data: Any;
  error: PgError | null;
  count: number | null;
}

/** Resolved envelope an `.rpc(...)` call awaits to. */
export interface PgRpcAwaited {
  data: Any;
  error: PgError | null;
}

/** Terminal builder returned by `.single()` / `.maybeSingle()`. */
export interface PgSingleBuilder extends PromiseLike<PgAwaitedSingle> {}

export interface PgQueryBuilderPublic extends PromiseLike<PgAwaited> {
  select(columns?: string, opts?: { count?: "exact"; head?: boolean }): PgQueryBuilderPublic;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): PgQueryBuilderPublic;
  update(patch: Record<string, unknown>): PgQueryBuilderPublic;
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string },
  ): PgQueryBuilderPublic;
  delete(opts?: { count?: "exact" }): PgQueryBuilderPublic;
  eq(column: string, value: unknown): PgQueryBuilderPublic;
  neq(column: string, value: unknown): PgQueryBuilderPublic;
  gt(column: string, value: unknown): PgQueryBuilderPublic;
  gte(column: string, value: unknown): PgQueryBuilderPublic;
  lt(column: string, value: unknown): PgQueryBuilderPublic;
  lte(column: string, value: unknown): PgQueryBuilderPublic;
  in(column: string, values: readonly unknown[]): PgQueryBuilderPublic;
  is(column: string, value: null | boolean): PgQueryBuilderPublic;
  not(column: string, operator: string, value: unknown): PgQueryBuilderPublic;
  ilike(column: string, pattern: string): PgQueryBuilderPublic;
  like(column: string, pattern: string): PgQueryBuilderPublic;
  contains(column: string, value: Record<string, unknown> | unknown[]): PgQueryBuilderPublic;
  or(filterString: string): PgQueryBuilderPublic;
  order(column: string, opts?: { ascending?: boolean }): PgQueryBuilderPublic;
  limit(n: number): PgQueryBuilderPublic;
  range(from: number, to: number): PgQueryBuilderPublic;
  single(): PgSingleBuilder;
  maybeSingle(): PgSingleBuilder;
}

export interface PgClient {
  from(table: string): PgQueryBuilderPublic;
  rpc(fnName: string, args?: Record<string, unknown>): Promise<PgRpcAwaited>;
}

/**
 * Build the supabase-js-shaped client backed by plain `pg`. The returned object
 * is a drop-in for the narrow `.from()/.rpc()` surface `src/supabase.ts` uses.
 */
export function createPgClient(): PgClient {
  return {
    from(table: string): PgQueryBuilderPublic {
      return new QueryBuilder(table) as unknown as PgQueryBuilderPublic;
    },
    rpc: (fnName: string, args?: Record<string, unknown>) =>
      rpc(fnName, args) as Promise<PgRpcAwaited>,
  };
}
