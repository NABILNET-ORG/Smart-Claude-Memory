import { embed } from "../ollama.js";
import { searchChunks } from "../supabase.js";
import { currentProjectId } from "../project.js";

export async function searchMemory(args: {
  query: string;
  limit?: number;
  min_similarity?: number;
  project_id?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const [queryVec] = await embed([args.query]);
  const results = await searchChunks(
    projectId,
    queryVec,
    args.limit ?? 5,
    args.min_similarity ?? 0.0,
  );
  return {
    project_id: projectId,
    query: args.query,
    count: results.length,
    results,
  };
}
