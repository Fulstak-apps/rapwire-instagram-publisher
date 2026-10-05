import test from "node:test";
import assert from "node:assert/strict";
import { rankViralCandidates, publishPriorityFor } from "./viral-selection.mjs";

const source = handle => ({ handle });
const candidate = (handle, viewCount, extra = {}) => ({ source: source(handle), viewCount, profilePosition: 0, visibleCaption: "", ...extra });

test("measured viral views outrank priority-artist affinity", () => {
  const ranked = rankViralCandidates([
    candidate("small-priority", 25_000, { visibleCaption: "Drake has a new update" }),
    candidate("big-viral", 2_000_000, { visibleCaption: "A viral crowd clip" })
  ]);
  assert.equal(ranked[0].source.handle, "big-viral");
});

test("fresh momentum resolves ties and unknown counts fall back to recency", () => {
  const ranked = rankViralCandidates([
    candidate("slow", 100_000, { viewVelocity: 1 }),
    candidate("fast", 100_000, { viewVelocity: 10_000 }),
    candidate("unknown-old", 0, { profilePosition: 4 }),
    candidate("unknown-new", 0, { profilePosition: 1 })
  ]);
  assert.deepEqual(ranked.map(item => item.source.handle), ["fast", "slow", "unknown-new", "unknown-old"]);
  assert.ok(publishPriorityFor(ranked[0]) > publishPriorityFor(ranked[2]));
});
