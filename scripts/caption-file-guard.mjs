import fs from "node:fs/promises";
import path from "node:path";

// Two September 2026 carousel posts went live with their caption literally
// set to a caption file path (e.g. "queue/rapwire-carousel-2026-09-28-0800-caption.md")
// because a queue writer stored the file's path instead of its contents.
// A file path must never reach the Meta API as caption text.
export function captionLooksLikeFilePath(value) {
  const firstLine = String(value || "").split("\n")[0].trim();
  if (!firstLine || /\s{2,}/.test(firstLine)) return false;
  return /\.md$/i.test(firstLine) || /(?:^|[\/\\])(?:queue|outputs|captions)\//i.test(firstLine);
}

// Reads the caption file referenced by a path-like caption value.
// Resolves { relPath, contents } when the file holds real copy.
// Throws (never returns the path as text) when the file is missing,
// empty, or resolves to another path.
export async function resolveCaptionFileContents(value, baseDir = process.cwd()) {
  const firstLine = String(value || "").split("\n")[0].trim();
  const relPath = firstLine.replace(/^[.\\/]+/, "");
  if (!captionLooksLikeFilePath(value) || !relPath) {
    throw new Error("value is not a caption file path");
  }
  let contents;
  try {
    contents = (await fs.readFile(path.resolve(baseDir, relPath), "utf8")).trim();
  } catch (error) {
    throw new Error(`caption file not readable (${relPath}): ${error.message}`);
  }
  if (!contents) throw new Error(`caption file is empty (${relPath})`);
  if (captionLooksLikeFilePath(contents)) {
    throw new Error(`caption file resolves to another path (${relPath})`);
  }
  return { relPath, contents };
}
