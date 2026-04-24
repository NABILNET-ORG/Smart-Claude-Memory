import { basename } from "node:path";

export function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "default";
}

export function detectProjectId(cwd: string = process.cwd()): string {
  return slugify(basename(cwd) || "default");
}

export const currentProjectId = detectProjectId();

// v1.1.1 display/slug decoupling — DB key stays "claude-memory" (preserves 1013 memory chunks);
// user-facing renders show "smart-claude-memory" to match post-rebrand brand.
// Remove this bridge once Supabase rows are migrated to the new slug (see v1.2.0).
export function displayProjectName(projectId: string): string {
  if (projectId === "claude-memory") return "smart-claude-memory";
  return projectId;
}
