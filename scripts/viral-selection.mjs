import { candidateScore } from "./growth-feedback.mjs";
import { priorityArtistsIn } from "./artist-priority.mjs";

// View counts are the primary signal for source-video reposts.  Artist and
// learned-source signals deliberately break close calls only; they must never
// make a low-view clip outrank a genuinely viral one.
export function enrichViralCandidate(candidate, feedback = {}, now = Date.now()) {
  const priorityArtists = candidate.priorityArtists || priorityArtistsIn(candidate.visibleCaption || "");
  return {
    ...candidate,
    priorityArtists,
    viralScore: candidateScore({ ...candidate, priorityArtists }, feedback, now)
  };
}

export function rankViralCandidates(candidates, { feedback = {}, now = Date.now() } = {}) {
  return candidates
    .map(candidate => enrichViralCandidate(candidate, feedback, now))
    .sort((left, right) => {
      const leftMeasured = Number(left.viewCount || 0) > 0;
      const rightMeasured = Number(right.viewCount || 0) > 0;
      // A measured view count is stronger evidence than an unmeasured clip;
      // do not present a zero as if it were a poor engagement result.
      if (leftMeasured !== rightMeasured) return rightMeasured ? 1 : -1;
      if (leftMeasured && Number(right.viewCount) !== Number(left.viewCount)) {
        return Number(right.viewCount) - Number(left.viewCount);
      }
      if (Number(right.viralScore) !== Number(left.viralScore)) return Number(right.viralScore) - Number(left.viralScore);
      return Number(left.profilePosition || 0) - Number(right.profilePosition || 0)
        || String(left.source?.handle || "").localeCompare(String(right.source?.handle || ""));
    });
}

export function publishPriorityFor(candidate) {
  const views = Math.max(0, Number(candidate.viewCount) || 0);
  const velocity = Math.max(0, Number(candidate.viewVelocity) || 0);
  if (!views) return 50;
  // Keep this below editorial emergency priorities while ensuring that the
  // publisher draws the most-viewed verified clips before ordinary reserves.
  return Math.min(900, 100 + Math.round(Math.log1p(views) * 40) + Math.round(Math.min(200, Math.log1p(velocity) * 20)));
}
