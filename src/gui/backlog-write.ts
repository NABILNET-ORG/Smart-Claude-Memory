// Sovereign Command Center — Active Backlog write route (Phase 1, Epic F).
//
// Split out of server.ts to keep that file under the 750-line ceiling. Holds
// the single mutation the Kanban board needs: move a card between columns by
// patching its status. Schema is FROZEN — status-only, no reorder (no rank
// column exists), no other mutable fields.
//
// The handler is deliberately seam-driven: server.ts passes in the SAME
// helpers it uses for the graduation mutation routes (readJsonBody, sendJson)
// plus the BacklogStatus guard and the updateBacklog data accessor. This keeps
// behavior/conventions identical to the existing POST routes and lets tests
// stub updateBacklog without a Supabase round-trip.
//
// Auth: the bearer-token check (SCM_GUI_TOKEN) lives centrally in
// createGuiServer for every /api/ path except /api/health, so this route is
// already gated upstream — no per-route token logic is duplicated here.
//
// Route: PATCH /api/backlog/:id   (:id = positive integer)
//   body  { status: "todo"|"in_progress"|"blocked"|"done" }   (other fields ignored)
//   200   { ok:true, task: BacklogRow }
//   400   { ok:false, reason }   — non-integer id, or missing/invalid status
//   404   { ok:false, reason }   — row not found
//   500   { ok:false, reason }   — unexpected DB error

import type http from "node:http";
import type { BacklogRow, BacklogStatus } from "../supabase.js";

export type BacklogPatchHelpers = {
  /** Read + JSON-parse the request body. Mirrors server.ts readJsonBody. */
  readJsonBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  /** Write a JSON response. Mirrors server.ts sendJson. */
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  /** Narrowing guard for the four legal statuses. Mirrors server.ts isBacklogStatus. */
  isBacklogStatus: (s: string) => s is BacklogStatus;
  /** Data accessor — patches the row's status and returns the fresh row. */
  updateBacklog: (
    id: number,
    patch: { status: BacklogStatus },
  ) => Promise<BacklogRow>;
};

/**
 * Handle PATCH /api/backlog/:id. `id` is the already-extracted path segment
 * (string) so the caller stays the single owner of the route regex; we re-parse
 * + validate it here so the integer contract is enforced at exactly one place.
 *
 * Always terminates the response (success or error) — never falls through.
 */
export async function handleBacklogPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  helpers: BacklogPatchHelpers,
  rawId: string,
): Promise<void> {
  // Integer-id contract. The route regex already guarantees /^\d+$/, but we
  // re-validate defensively: reject anything that isn't a finite positive int.
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return helpers.sendJson(res, 400, {
      ok: false,
      reason: "id must be a positive integer",
    });
  }

  const body = await helpers.readJsonBody(req);
  const rawStatus = body.status;
  if (typeof rawStatus !== "string" || !helpers.isBacklogStatus(rawStatus)) {
    return helpers.sendJson(res, 400, {
      ok: false,
      reason: "status must be one of: todo, in_progress, blocked, done",
    });
  }

  // status ONLY — every other inbound field is intentionally ignored to keep
  // the write surface minimal and the frozen schema untouched.
  try {
    const task = await helpers.updateBacklog(id, { status: rawStatus });
    return helpers.sendJson(res, 200, { ok: true, task });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Supabase .single() raises "0 rows" / "multiple rows" style messages when
    // the id matched nothing — surface that as a 404; everything else is a 500.
    const notFound = /no rows|0 rows|not found|PGRST116/i.test(msg);
    return helpers.sendJson(res, notFound ? 404 : 500, {
      ok: false,
      reason: msg,
    });
  }
}
