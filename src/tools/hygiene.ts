import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

export const HARD_LIMIT = 750;

export async function checkCodeHygiene(args: {
  paths: string[];
}): Promise<{
  limit: number;
  files: Array<{
    path: string;
    name: string;
    exists: boolean;
    lines: number;
    over_limit: boolean;
    grandfathered: boolean;
    status: "ok" | "over" | "grandfathered" | "missing";
  }>;
  summary: { ok: number; grandfathered: number; over: number; missing: number };
}> {
  const limit = HARD_LIMIT;
  const summary = { ok: 0, grandfathered: 0, over: 0, missing: 0 };
  const files = await Promise.all(
    args.paths.map(async (p) => {
      const name = basename(p);
      try {
        await stat(p);
      } catch {
        summary.missing++;
        return {
          path: p,
          name,
          exists: false,
          lines: 0,
          over_limit: false,
          grandfathered: false,
          status: "missing" as const,
        };
      }
      const text = await readFile(p, "utf8");
      const lines = text.split(/\r?\n/).length;
      const overLimit = lines > limit;
      // "Grandfathered" == already oversized on disk; edits are allowed with warning,
      // brand-new writes that *push* a file over should be blocked by the hook.
      const grandfathered = overLimit;
      if (overLimit) {
        summary.grandfathered++;
        summary.over++;
      } else {
        summary.ok++;
      }
      return {
        path: p,
        name,
        exists: true,
        lines,
        over_limit: overLimit,
        grandfathered,
        status: overLimit ? ("grandfathered" as const) : ("ok" as const),
      };
    }),
  );
  return { limit, files, summary };
}
