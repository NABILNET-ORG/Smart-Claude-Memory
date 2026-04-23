import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { glob } from "glob";
import archiver from "archiver";

const MEMORY_ROOTS = (process.env.MEMORY_ROOTS ?? "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

if (MEMORY_ROOTS.length === 0) {
  console.error("MEMORY_ROOTS not set in .env");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `backups/${stamp}`;
await mkdir(backupDir, { recursive: true });

const zipPath = `${backupDir}/memory-backup.zip`;
const output = createWriteStream(zipPath);
const archive = archiver("zip", { zlib: { level: 9 } });
archive.pipe(output);

const allFiles: string[] = [];
for (const root of MEMORY_ROOTS) {
  const files = await glob("**/*.md", {
    cwd: root,
    absolute: true,
    nodir: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/backups/**"],
  });
  for (const f of files) {
    const content = await readFile(f, "utf8");
    const entryName = f.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
    archive.append(content, { name: entryName.replace(/^\/+/, "") });
    allFiles.push(f);
  }
}

await new Promise<void>((resolve, reject) => {
  output.on("close", () => resolve());
  archive.on("error", reject);
  archive.finalize();
});

await writeFile(
  `${backupDir}/manifest.json`,
  JSON.stringify({ stamp, file_count: allFiles.length, files: allFiles }, null, 2),
);

if (process.argv.includes("--confirm-delete")) {
  for (const f of allFiles) await rm(f, { force: true });
  console.log(`Deleted ${allFiles.length} files. Backup at ${zipPath}`);
} else {
  console.log(
    `Dry run. ${allFiles.length} files would be deleted. Backup written to ${zipPath}. ` +
      `Re-run with --confirm-delete to remove the originals.`,
  );
}
