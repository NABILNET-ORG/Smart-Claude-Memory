import { embed, chat } from "../ollama.js";
import { searchChunks } from "../supabase.js";
import { currentProjectId } from "../project.js";

type RerankedHit = {
  id: number;
  content: string;
  file_origin: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
  similarity: number;
  relevance_score?: number;
  conflict?: {
    has_conflict: boolean;
    severity: "none" | "low" | "medium" | "high";
    reason: string;
  };
};

function parseJsonBlock(text: string): unknown {
  // Strip common code-fence wrappers and grab the first JSON object.
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in LLM response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function rerank(
  query: string,
  hits: RerankedHit[],
  model?: string,
): Promise<RerankedHit[]> {
  if (hits.length === 0) return hits;
  const prompt = [
    {
      role: "system" as const,
      content:
        "You are a precise retrieval re-ranker. Score each passage from 0.0 to 1.0 for how directly it answers the query. Return ONLY compact JSON: {\"scores\":[<float>,...]} in the same order as input passages. No prose.",
    },
    {
      role: "user" as const,
      content:
        `Query: ${query}\n\nPassages:\n` +
        hits
          .map((h, i) => `[${i}] (sim=${h.similarity.toFixed(3)})\n${h.content.slice(0, 500)}`)
          .join("\n\n"),
    },
  ];
  try {
    const out = await chat(prompt, { model, temperature: 0, timeoutMs: 30_000 });
    const parsed = parseJsonBlock(out) as { scores: number[] };
    const scored = hits.map((h, i) => ({
      ...h,
      relevance_score: typeof parsed.scores?.[i] === "number" ? parsed.scores[i] : h.similarity,
    }));
    scored.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
    return scored;
  } catch {
    // Fall back silently to vector order if the LLM misbehaves.
    return hits;
  }
}

async function detectConflict(
  proposedChange: string,
  rule: string,
  model?: string,
): Promise<{ has_conflict: boolean; severity: "none" | "low" | "medium" | "high"; reason: string }> {
  const prompt = [
    {
      role: "system" as const,
      content:
        "You check whether a proposed code or behavior change violates a governance rule. Respond with ONLY compact JSON: " +
        '{"has_conflict": bool, "severity": "none"|"low"|"medium"|"high", "reason": "<one sentence>"}. ' +
        "Set has_conflict=false and severity=none if the change is neutral or complementary to the rule.",
    },
    {
      role: "user" as const,
      content: `Rule:\n${rule}\n\nProposed change:\n${proposedChange}`,
    },
  ];
  try {
    const out = await chat(prompt, { model, temperature: 0, timeoutMs: 30_000 });
    const parsed = parseJsonBlock(out) as {
      has_conflict?: boolean;
      severity?: "none" | "low" | "medium" | "high";
      reason?: string;
    };
    return {
      has_conflict: Boolean(parsed.has_conflict),
      severity: (parsed.severity as "none" | "low" | "medium" | "high") ?? "none",
      reason: parsed.reason ?? "",
    };
  } catch (e) {
    return { has_conflict: false, severity: "none", reason: `(llm-error: ${(e as Error).message})` };
  }
}

export async function checkRuleConflicts(args: {
  proposed_change: string;
  project_id?: string;
  top_k?: number;
  rerank?: boolean;
  llm_model?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const topK = Math.min(args.top_k ?? 5, 10);

  const [qVec] = await embed([args.proposed_change]);
  const vectorHits = await searchChunks(projectId, qVec, topK * 2, 0);
  const asHits: RerankedHit[] = vectorHits.map((h) => ({ ...h }));

  const maybeReranked = args.rerank === false ? asHits : await rerank(args.proposed_change, asHits, args.llm_model);
  const top = maybeReranked.slice(0, topK);

  // Analyze the top 3 for intent conflicts (keeps latency bounded).
  const analyze = top.slice(0, 3);
  for (const hit of analyze) {
    hit.conflict = await detectConflict(args.proposed_change, hit.content, args.llm_model);
  }

  const highest = analyze
    .map((h) => h.conflict?.severity ?? "none")
    .reduce<"none" | "low" | "medium" | "high">((acc, s) => {
      const order = { none: 0, low: 1, medium: 2, high: 3 } as const;
      return order[s] > order[acc] ? s : acc;
    }, "none");

  return {
    project_id: projectId,
    proposed_change: args.proposed_change,
    reranked: args.rerank !== false,
    top,
    highest_severity: highest,
    recommendation:
      highest === "high"
        ? "STOP — a high-severity conflict was detected. Review the flagged rule before proceeding."
        : highest === "medium"
          ? "Proceed with caution — at least one medium-severity conflict was flagged."
          : "No significant conflicts detected.",
  };
}
