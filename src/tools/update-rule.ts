import { embed } from "../ollama.js";
import { upsertRule } from "../supabase.js";
import { currentProjectId } from "../project.js";

export async function updateRule(args: {
  file_origin: string;
  chunk_index: number;
  content: string;
  metadata?: Record<string, unknown>;
  project_id?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const [vec] = await embed([args.content]);
  const id = await upsertRule(
    projectId,
    args.file_origin,
    args.chunk_index,
    args.content,
    vec,
    args.metadata ?? {},
  );
  return {
    id,
    project_id: projectId,
    file_origin: args.file_origin,
    chunk_index: args.chunk_index,
  };
}
