import test from "node:test";
import assert from "node:assert/strict";
import { fitInstagramCaption, INSTAGRAM_CAPTION_LIMIT } from "./instagram-caption.mjs";

test("keeps a complete, attributable Instagram caption within Meta's limit", () => {
  const source = "https://example.com/" + "a".repeat(200);
  const input = Array.from({ length: 5 }, (_, index) => `${index + 1}. Verified story ${"detail ".repeat(45)}\nSources: ${source} | ${source.replace(/a$/, "b")}`).join("\n") + "\n\n@Rapwire247";
  const result = fitInstagramCaption(input);
  assert.ok(result.length <= INSTAGRAM_CAPTION_LIMIT);
  assert.match(result, /@Rapwire247$/);
  assert.doesNotMatch(result, /\| https?:\/\//);
});

test("uses a word-boundary fallback while preserving the account footer", () => {
  const result = fitInstagramCaption(`${"word ".repeat(1000)}\n\n@Rapwire247`);
  assert.ok(result.length <= INSTAGRAM_CAPTION_LIMIT);
  assert.match(result, /…\n\n@Rapwire247$/);
});
