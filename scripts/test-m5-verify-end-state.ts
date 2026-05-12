// Final verification: confirm candidate #8 was promoted to agent_skills #8
// and curriculum_tasks #5 reflects verified state. Read-only.
import { supabase } from "../src/supabase.js";

const [{ data: cand, error: cErr }, { data: skill, error: sErr }, { data: task, error: tErr }] =
  await Promise.all([
    supabase
      .from("skill_candidates")
      .select("id, state, proposed_name, model, promoted_skill_id, updated_at")
      .eq("id", 8)
      .maybeSingle(),
    supabase
      .from("agent_skills")
      .select("id, name, description, version, created_at")
      .eq("id", 8)
      .maybeSingle(),
    supabase
      .from("curriculum_tasks")
      .select("id, kind, status, linked_candidate_id, linked_checkpoint_id, verified_at")
      .eq("id", 5)
      .maybeSingle(),
  ]);

console.log(
  JSON.stringify(
    {
      candidate_8: { error: cErr?.message ?? null, row: cand },
      skill_8: { error: sErr?.message ?? null, row: skill },
      task_5: { error: tErr?.message ?? null, row: task },
    },
    null,
    2,
  ),
);
