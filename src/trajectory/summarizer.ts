import { chat } from "../ollama.js";

const DEFAULT_MODEL = process.env.OLLAMA_TRAJECTORY_MODEL ?? "gemma3:e2b";

const SYSTEM_PROMPT =
  "You are a log compression engine. Produce a dense ~50-token semantic summary of the operational trajectory log provided. " +
  "Emphasize: WHAT happened (the action taken), WHAT FOR (intent or outcome), and KEY identifiers (file paths, error codes, IDs, function names). " +
  "Strip all chat-style filler, greetings, and meta-commentary. Output exactly one paragraph, single line, no bullets, no preamble, no quotes. " +
  "Do not introduce your output. Begin directly with the summary content.";

const USER_PREFIX =
  "Compress the following trajectory log into a dense ~50-token semantic summary:\n\n";

const PREAMBLE_REGEX =
  /^(?:summary|compressed|here(?:'s| is)(?:\s+(?:the|a))?(?:\s+(?:summary|compressed\s+log|dense\s+summary))?|the\s+log)\s*[:\-—]\s*/i;

const MAX_CHARS = 400;

export async function summarizeTrajectory(
  stripped: string,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{
  summary: string;
  summaryTokens: number;
  model: string;
}> {
  if (stripped.trim().length === 0) {
    throw new Error("summarizeTrajectory: empty input");
  }

  const model = opts.model ?? DEFAULT_MODEL;

  const chatPromise = chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${USER_PREFIX}${stripped}` },
    ],
    {
      model,
      temperature: 0.2,
      timeoutMs: 60_000,
    },
  );

  const raw = opts.signal ? await raceAbort(chatPromise, opts.signal) : await chatPromise;

  const summary = postProcess(raw);
  const summaryTokens = Math.ceil(summary.length / 4);

  return { summary, summaryTokens, model };
}

function postProcess(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\s*[\r\n]+\s*/g, " ");
  s = s.replace(/\s{2,}/g, " ");
  // Strip leading preambles up to 3 times in case the model stacks them.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PREAMBLE_REGEX, "").trim();
    if (next === s) break;
    s = next;
  }
  if (s.length > MAX_CHARS) {
    s = truncateAtSentence(s, MAX_CHARS);
  }
  return s;
}

function truncateAtSentence(s: string, max: number): string {
  const slice = s.slice(0, max);
  let cut = -1;
  for (const punct of [". ", "! ", "? "]) {
    const idx = slice.lastIndexOf(punct);
    if (idx > cut) cut = idx + 1;
  }
  if (cut > 0) return slice.slice(0, cut).trim();
  // No sentence boundary found within window — clean cut at last word boundary.
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("summarizeTrajectory: aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("summarizeTrajectory: aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
