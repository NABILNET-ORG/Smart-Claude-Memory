import { supabase } from "../src/supabase.js";
import { runTrajectoryCompactorOnce } from "../src/trajectory/daemon.js";

async function main() {
  const before = new Date().toISOString();
  await runTrajectoryCompactorOnce();
  // Fire-and-forget: emit's promise has already resolved (we awaited the runOnce);
  // but the insert itself is the same await chain inside emit, so by now the row exists.
  // Defensive: tiny delay for clock skew.
  await new Promise((r) => setTimeout(r, 200));

  const { data, error } = await supabase
    .from("daemon_telemetry")
    .select("event_type, payload, created_at")
    .eq("daemon", "trajectory_compactor")
    .gte("created_at", before)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`readback failed: ${error.message}`);

  const types = (data ?? []).map((r) => r.event_type);
  if (!types.includes("run_started")) {
    throw new Error(`missing run_started — got: ${JSON.stringify(types)}`);
  }
  if (!(types.includes("run_ended") || types.includes("run_errored"))) {
    throw new Error(`missing terminal event — got: ${JSON.stringify(types)}`);
  }

  // Verify the run_ended (or run_errored) payload shape is non-trivial.
  const terminal = (data ?? []).find(
    (r) => r.event_type === "run_ended" || r.event_type === "run_errored",
  );
  const p = terminal?.payload as Record<string, unknown> | undefined;
  if (!p || typeof p.duration_ms !== "number") {
    throw new Error(`terminal payload missing duration_ms: ${JSON.stringify(terminal)}`);
  }

  console.log("ok: trajectory_compactor emitted", types, "with payload keys:", Object.keys(p));
}
main().catch((e) => { console.error(e); process.exit(1); });
