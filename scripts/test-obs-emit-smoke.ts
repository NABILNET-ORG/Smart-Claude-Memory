import { emit } from "../src/telemetry/emit.js";
import { supabase } from "../src/supabase.js";

async function main() {
  // Assertion 1 — schema reachability (preserved from Task 1)
  {
    const { error } = await supabase.from("daemon_telemetry").select("id").limit(1);
    if (error) throw new Error(`schema check failed: ${error.message}`);
    console.log("ok: daemon_telemetry schema reachable");
  }

  // Assertion 2 — happy-path emit + readback
  const stamp = `s23-obs-smoke-${Date.now()}`;
  await emit({
    daemon: "trajectory_compactor",
    event: "run_ended",
    payload: { compacted: 0, skipped: 0, errored: 0, duration_ms: 12, smoke_tag: stamp },
  });
  const { data, error } = await supabase
    .from("daemon_telemetry")
    .select("daemon, event_type, payload")
    .contains("payload", { smoke_tag: stamp })
    .limit(1);
  if (error) throw new Error(`readback failed: ${error.message}`);
  if (!data?.length) throw new Error("emit did not persist a row");
  const row = data[0];
  if (row.daemon !== "trajectory_compactor" || row.event_type !== "run_ended") {
    throw new Error(`unexpected row: ${JSON.stringify(row)}`);
  }
  console.log("ok: emit persisted + readback matched");

  // Assertion 3 — fire-and-forget contract
  // Deliberately violate the daemon CHECK constraint. Supabase returns { error };
  // emit() MUST swallow it (log to stderr) and resolve cleanly. The bogus row must
  // NOT be persisted (proves CHECK actually rejected; proves emit caught a real error).
  const bogusTag = `bogus-${stamp}`;
  let threw = false;
  try {
    await emit({
      // @ts-expect-error — intentional contract test
      daemon: "bogus_daemon_name",
      event: "run_ended",
      payload: { compacted: 0, skipped: 0, errored: 0, duration_ms: 1, smoke_tag: bogusTag },
    });
  } catch {
    threw = true;
  }
  if (threw) throw new Error("emit re-threw on DB error — fire-and-forget contract violated");
  const { data: bogus } = await supabase
    .from("daemon_telemetry")
    .select("id")
    .contains("payload", { smoke_tag: bogusTag });
  if (bogus && bogus.length > 0) {
    throw new Error("bogus row was persisted — CHECK constraint missing or weakened");
  }
  console.log("ok: emit swallowed CHECK violation (fire-and-forget contract upheld)");

  console.log("All 3 smoke assertions passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
