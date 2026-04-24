import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { captionImage, embed } from "../ollama.js";
import { upsertChunks, md5 } from "../supabase.js";
import { currentProjectId } from "../project.js";

export async function indexImage(args: {
  image_path: string;
  caption_prompt?: string;
  project_id?: string;
  vision_model?: string;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const abs = resolve(args.image_path);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`Not a file: ${abs}`);

  const caption = await captionImage(abs, args.caption_prompt, { model: args.vision_model });
  if (!caption.trim()) throw new Error("Vision model returned an empty caption.");

  const [vec] = await embed([caption]);
  const fileHash = md5(caption);

  await upsertChunks(projectId, [
    {
      content: caption,
      file_origin: abs,
      chunk_index: 0,
      embedding: vec,
      file_hash: fileHash,
      metadata: {
        type: "image",
        image_path: abs,
        bytes: info.size,
        caption_chars: caption.length,
      },
    },
  ]);

  return {
    action: "index_image",
    project_id: projectId,
    image_path: abs,
    caption_chars: caption.length,
    caption_preview: caption.slice(0, 300),
  };
}
