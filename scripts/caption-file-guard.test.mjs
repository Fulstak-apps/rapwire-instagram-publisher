import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captionLooksLikeFilePath, resolveCaptionFileContents } from "./caption-file-guard.mjs";

test("detects stored caption file paths", () => {
  assert.equal(captionLooksLikeFilePath("queue/rapwire-carousel-2026-09-28-0800-caption.md"), true);
  assert.equal(captionLooksLikeFilePath("outputs/rapwire-carousel-2026-09-27-1700-caption.md\n\n@Rapwire247"), true);
  assert.equal(captionLooksLikeFilePath("captions/launch.md"), true);
  assert.equal(captionLooksLikeFilePath("./queue/item-caption.MD"), true);
});

test("ignores real caption copy", () => {
  assert.equal(captionLooksLikeFilePath("1) Rick Ross surrendered to Miami Beach police.\n\n@Rapwire247"), false);
  assert.equal(captionLooksLikeFilePath(""), false);
  assert.equal(captionLooksLikeFilePath("This caption mentions queue/ as part of a sentence"), false);
  assert.equal(captionLooksLikeFilePath("Two words about a .md file"), false);
});

test("resolves a caption file to its contents", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rapwire-caption-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "queue"), { recursive: true });
  fs.writeFileSync(path.join(dir, "queue", "cap.md"), "Real caption copy.\n\n@Rapwire247\n");
  const { relPath, contents } = await resolveCaptionFileContents("queue/cap.md", dir);
  assert.equal(relPath, "queue/cap.md");
  assert.equal(contents, "Real caption copy.\n\n@Rapwire247");
});

test("fails loudly instead of posting a path when the file is missing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rapwire-caption-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(() => resolveCaptionFileContents("queue/missing-caption.md", dir));
});

test("fails loudly when the caption file is empty", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rapwire-caption-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "queue"), { recursive: true });
  fs.writeFileSync(path.join(dir, "queue", "empty.md"), "   \n");
  await assert.rejects(() => resolveCaptionFileContents("queue/empty.md", dir));
});
