// Heuristic noise-stripper for M2 AgentDiet (pre-LLM trajectory compression stage).
// Pure function: no I/O, no logging, no side effects. Regex + string ops only.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const STACK_FRAME_RE = /^\s+at\s/;
const NOISE_LEVEL_RE = /^(DEBUG|TRACE|VERBOSE):\s/;
const BLANK_RE = /^\s*$/;
const JSON_MIN_LEN = 500;
const STACK_KEEP = 5;
const MAX_CHARS = 100_000;
const TRUNC_SUFFIX = "[... source truncated at 100k chars]";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isJsonShaped(line: string): boolean {
  if (line.length <= JSON_MIN_LEN) return false;
  const trimmed = line.trim();
  if (trimmed.length <= JSON_MIN_LEN) return false;
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  const opensObject = first === "{" && last === "}";
  const opensArray = first === "[" && last === "]";
  if (!opensObject && !opensArray) return false;
  return trimmed.includes(":");
}

function collapseJsonBlobs(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (isJsonShaped(line)) {
      out.push(`[json blob ${line.length} chars elided]`);
    } else {
      out.push(line);
    }
  }
  return out;
}

function truncateStackTraces(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (STACK_FRAME_RE.test(lines[i]!)) {
      let j = i;
      while (j < lines.length && STACK_FRAME_RE.test(lines[j]!)) j++;
      const run = j - i;
      if (run > STACK_KEEP) {
        for (let k = i; k < i + STACK_KEEP; k++) out.push(lines[k]!);
        out.push(`... [${run - STACK_KEEP} more frames elided]`);
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]!);
      }
      i = j;
    } else {
      out.push(lines[i]!);
      i++;
    }
  }
  return out;
}

function dedupeConsecutive(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const current = lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j] === current) j++;
    const run = j - i;
    out.push(current);
    if (run > 1) out.push(`[× ${run} repeats]`);
    i = j;
  }
  return out;
}

function stripNoiseLines(lines: string[]): string[] {
  const filtered = lines.filter((l) => !NOISE_LEVEL_RE.test(l));
  const out: string[] = [];
  let prevBlank = false;
  for (const line of filtered) {
    const isBlank = BLANK_RE.test(line);
    if (isBlank) {
      if (!prevBlank) out.push("");
      prevBlank = true;
    } else {
      out.push(line);
      prevBlank = false;
    }
  }
  return out;
}

function capLength(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const room = MAX_CHARS - TRUNC_SUFFIX.length;
  const head = room > 0 ? text.slice(0, room) : "";
  return `${head}${TRUNC_SUFFIX}`;
}

export function stripTrajectory(raw: string): {
  stripped: string;
  sourceTokens: number;
  strippedTokens: number;
} {
  const sourceTokens = estimateTokens(raw);
  if (raw.length === 0) {
    return { stripped: "", sourceTokens: 0, strippedTokens: 0 };
  }

  const noAnsi = raw.replace(ANSI_RE, "");
  const lines = noAnsi.split(/\r?\n/);
  const afterJson = collapseJsonBlobs(lines);
  const afterStack = truncateStackTraces(afterJson);
  const afterDedupe = dedupeConsecutive(afterStack);
  const afterNoise = stripNoiseLines(afterDedupe);

  const joined = afterNoise.join("\n");
  const stripped = capLength(joined);
  const strippedTokens = estimateTokens(stripped);

  return { stripped, sourceTokens, strippedTokens };
}
