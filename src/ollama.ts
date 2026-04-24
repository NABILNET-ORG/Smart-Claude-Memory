import { readFile } from "node:fs/promises";
import { config } from "./config.js";

type EmbedResponse = { embeddings: number[][] };

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const res = await fetch(`${config.OLLAMA_HOST}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.OLLAMA_EMBED_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embed failed ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as EmbedResponse;
  const bad = json.embeddings.find((v) => v.length !== config.EMBED_DIM);
  if (bad) {
    throw new Error(
      `Embedding dim mismatch: got ${bad.length}, expected ${config.EMBED_DIM}. ` +
        `Check OLLAMA_EMBED_MODEL and EMBED_DIM in .env.`,
    );
  }
  return json.embeddings;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string; images?: string[] };
type ChatResponse = { message: { content: string } };

const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "qwen3-coder:480b-cloud";
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? "moondream";

export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const model = opts.model ?? CHAT_MODEL;
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? 60_000;
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${config.OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: opts.temperature != null ? { temperature: opts.temperature } : undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`chat failed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as ChatResponse;
    return json.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

/** Moondream (or any multimodal Ollama model) caption. Returns plain text. */
export async function captionImage(
  imagePath: string,
  prompt = "Describe this image in detail, including any text, diagrams, people, objects, and inferred context.",
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
  const bytes = await readFile(imagePath);
  const base64 = bytes.toString("base64");
  return chat(
    [{ role: "user", content: prompt, images: [base64] }],
    { model: opts.model ?? VISION_MODEL, timeoutMs: opts.timeoutMs ?? 120_000 },
  );
}
