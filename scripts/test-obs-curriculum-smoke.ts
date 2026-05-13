import { supabase } from "../src/supabase.js";
import { runCurriculumScannerOnce, recordVerified } from "../src/curriculum/daemon.js";

async function main() {
  const before = new Date().toISOString();

  // Surface 1: tick lifecycle
  await runCurriculumScannerOnce();

  // Surface 2: orchestrator state mutation. recordVerified is synchronous in the existing
  // code; the void emit() inside it is fire-and-forget, so allow the insert to flush.
  recordVerified(false);
  await new Promise((r) => setTimeout(r, 400));

  const { data, error } = await supabase
    .from("daemon_telemetry")
    .select("event_type, payload, created_at")
    .eq("daemon", "curriculum_scanner")
    .gte("created_at", before)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`readback failed: ${error.message}`);

  const types = (data ?? []).map((r) => r.event_type);
  if (!types.includes("run_started")) {
    throw new Error(`missing tick run_started — got: ${JSON.stringify(types)}`);
  }
  if (!(types.includes("run_ended") || types.includes("run_errored"))) {
    throw new Error(`missing terminal tick event — got: ${JSON.stringify(types)}`);
  }
  const sawTaskOutcome = (data ?? []).some(
    (r) => r.event_type === "task_outcome" && typeof (r.payload as Record<string, unknown>)?.verified === "number"
  );
  if (!sawTaskOutcome) {
    throw new Error(`missing task_outcome with verified delta — got events: ${JSON.stringify(types)}`);
  }

  console.log("ok: curriculum_scanner emitted", types);
  console.log("ok: task_outcome event captured recordVerified delta");
}
main().catch((e) => { console.error(e); process.exit(1); });
