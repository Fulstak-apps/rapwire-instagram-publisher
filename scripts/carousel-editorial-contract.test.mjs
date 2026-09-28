import test from "node:test";
import assert from "node:assert/strict";
import {carouselEditorialIssues} from "./carousel-editorial-contract.mjs";

const good = {
  type: "original_editorial_carousel",
  headline: "Rap news roundup",
  body: "Five artists and stories are covered with clear context.",
  caption: "1) First story has a complete explanation without links.\n\n2) Second story has a complete explanation without links.\n\n3) Third story has a complete explanation without links.\n\n4) Fourth story has a complete explanation without links.\n\n5) Fifth story has a complete explanation without links.",
  slide_editorial_copy: Array.from({length: 5}, (_, index) => ({slide: index + 1, headline: `Story ${index + 1}`, deck: "A short, readable explanation appears directly on the illustrated scene.", text_on_art: true, top_banner: false})),
  brand_logo: {asset: "assets/rapwire247-logo.png", position: "bottom-left", transparent_background: true, backing_shape: "none"},
  carousel_visual_contract: "rapwire-editorial-carousel-v1",
  carousel_visual_qc: true
};

test("accepts a complete five-story RapWire editorial carousel", () => {
  assert.deepEqual(carouselEditorialIssues(good), []);
});

test("rejects a caption file path, links, and missing on-art copy proof", () => {
  const issues = carouselEditorialIssues({...good, caption: "queue/carousel-caption.md\n\n@Rapwire247", slide_editorial_copy: []});
  assert.ok(issues.some(issue => /file path/.test(issue)));
  assert.ok(issues.some(issue => /numbered story 1/.test(issue)));
  assert.ok(issues.some(issue => /slide copy/.test(issue)));
});
