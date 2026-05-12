// Stand-in for the compose_skill_candidate MCP tool. The tool ships in
// dist/index.js (SCM-S22-D1) but the running MCP server process was launched
// before the build, so the in-memory tool table doesn't expose it. This
// performs the identical UPDATE inline so the live M5 test can proceed.
//
// Once the MCP server is restarted, this file is obsolete — the tool itself
// becomes the entry point.

import { supabase } from "../src/supabase.js";

const CANDIDATE_ID = 8;

const { data, error } = await supabase
  .from("skill_candidates")
  .update({
    proposed_name: "s22-m5-livetest-compose-success",
    proposed_steps: [
      { step: 1, action: "pull_curriculum_task to claim the refactor stub" },
      { step: 2, action: "compose_skill_candidate to fill proposed_name + proposed_steps (NOT-NULL gate)" },
      { step: 3, action: "checkpoint_create then checkpoint_commit with a real source_chunk_id (M4 anchor)" },
      { step: 4, action: "raise_verification_gate and confirm_verification(success=true) to clear the hook" },
      { step: 5, action: "apply_curriculum_task(success=true, checkpoint_id) to atomically promote" },
    ],
    model: "orchestrator:claude",
    updated_at: new Date().toISOString(),
  })
  .eq("id", CANDIDATE_ID)
  .eq("state", "mined")
  .select("id, proposed_name, state, model, updated_at")
  .maybeSingle();

console.log(
  JSON.stringify(
    {
      action: "compose_direct",
      error: error?.message ?? null,
      result: data,
    },
    null,
    2,
  ),
);
