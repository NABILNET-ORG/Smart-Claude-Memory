import { config } from "./config.js";

export type RawChunk = {
  content: string;
  chunk_index: number;
  heading?: string;
};

export function chunkMarkdown(md: string): RawChunk[] {
  const size = config.CHUNK_SIZE;
  const overlap = config.CHUNK_OVERLAP;

  const sections = md
    .split(/\n(?=#{1,3}\s)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: RawChunk[] = [];
  let idx = 0;

  for (const section of sections) {
    const headingMatch = section.match(/^#{1,3}\s+(.+)/);
    const heading = headingMatch?.[1]?.trim();

    if (section.length <= size) {
      out.push({ content: section, chunk_index: idx++, heading });
      continue;
    }

    let cursor = 0;
    while (cursor < section.length) {
      const end = Math.min(cursor + size, section.length);
      out.push({
        content: section.slice(cursor, end),
        chunk_index: idx++,
        heading,
      });
      if (end === section.length) break;
      cursor = end - overlap;
    }
  }

  return out;
}
