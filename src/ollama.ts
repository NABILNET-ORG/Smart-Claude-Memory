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
