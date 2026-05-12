// Seed a second stale candidate so we can smoke-test the now-live
// compose_skill_candidate MCP tool (post-restart). Idempotent — reuses
// any existing row with the same pattern_hash.
import { supabase } from "../src/supabase.js";

const PATTERN_HASH = "s22-m5-livetest-stale-002";

const { data: existing } = await supabase
  .from("skill_candidates")
  .select("id, state, proposed_name")
  .eq("project_id", "claude-memory")
  .eq("pattern_hash", PATTERN_HASH)
  .maybeSingle();

if (existing) {
  console.log(JSON.stringify({ reused: true, row: existing }, null, 2));
} else {
  const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("skill_candidates")
    .insert({
      project_id: "claude-memory",
      pattern_hash: PATTERN_HASH,
      source_summary_ids: [],
      source_backlog_ids: [],
      frequency: 7,
      success_count: 6,
      candidate_embedding: null,
      proposed_name: null,
      proposed_steps: null,
      model: null,
      state: "mined",
      strategy: "centroid+ngram",
      created_at: createdAt,
      updated_at: createdAt,
    })
    .select("id, state, proposed_name, frequency")
    .single();
  console.log(JSON.stringify({ inserted: true, error: error?.message ?? null, row: data }, null, 2));
}
