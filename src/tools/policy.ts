import {
  listFrozenPatterns,
  addFrozenPattern,
  removeFrozenPattern,
  writeFrozenPatternsCache,
} from "../supabase.js";
import { currentProjectId } from "../project.js";

export async function listFrozen(args: { project_id?: string } = {}) {
  const projectId = args.project_id ?? currentProjectId;
  const patterns = await listFrozenPatterns(projectId);
  return {
    action: "list_frozen",
    project_id: projectId,
    count: patterns.length,
    patterns,
  };
}

export async function freezeFile(args: {
  pattern: string;
  project_id?: string;
  reason?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  await addFrozenPattern(projectId, args.pattern, args.reason);
  const cache = await writeFrozenPatternsCache();
  return {
    action: "freeze_file",
    project_id: projectId,
    pattern: args.pattern,
    reason: args.reason ?? null,
    cache,
  };
}

export async function unfreezeFile(args: {
  pattern: string;
  project_id?: string;
  confirm?: boolean;
  justification?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  // Require an explicit justification so an agent can't silently disarm the
  // policy. The user's original spec: "allow Claude (or the user) to manually
  // remove a pattern from frozen_features after getting permission."
  if (!args.justification || args.justification.trim().length < 4) {
    return {
      action: "unfreeze_file",
      project_id: projectId,
      pattern: args.pattern,
      removed: 0,
      warning:
        "Refused: unfreeze requires a 'justification' string (≥ 4 chars) explaining why the full-rewrite guardrail can be lifted for this file. Ask the user for permission first.",
    };
  }
  const removed = await removeFrozenPattern(projectId, args.pattern);
  const cache = await writeFrozenPatternsCache();
  return {
    action: "unfreeze_file",
    project_id: projectId,
    pattern: args.pattern,
    justification: args.justification,
    removed,
    cache,
  };
}
