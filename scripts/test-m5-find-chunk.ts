// Tiny helper: surface the most-recent memory_chunks.id for the project
// so checkpoint_commit has a valid FK target. Read-only.
import { supabase } from "../src/supabase.js";
import { currentProjectId } from "../src/project.js";

const projectId = currentProjectId;
const { data, error } = await supabase
  .from("memory_chunks")
  .select("id, file_origin, chunk_index")
  .eq("project_id", projectId)
  .order("id", { ascending: false })
  .limit(5);

console.log(
  JSON.stringify(
    {
      project_id: projectId,
      error: error?.message ?? null,
      rows: data ?? [],
    },
    null,
    2,
  ),
);
