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
