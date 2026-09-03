# RapWire operating rules

Updated September 3, 2026. This is the current contract; older thread prompts are historical.

## What runs

- Live checkout: `/Users/dw/Library/Application Support/RapWire/publisher-runtime`.
- Mac collector and GitHub dispatcher check every 120 seconds; overlapping runs are skipped. GitHub has a five-minute backup schedule, not an exact-start guarantee.
- New feed posts have a minimum ten-minute gap per platform, measured from confirmed publication. Slow processing or quota holds can delay delivery. Instagram and Threads have separate IDs, timers and retries.
- Codex runs the independent newsroom only at 9 a.m., noon and 5 p.m. America/Los_Angeles. Those existing runs research up to three strong stories, verify claims, prepare visuals and queue staggered delivery. No additional frequent Codex wakeups or model calls for routine reposts.
- The local Ollama editor runs hourly into ignored review/local-editor. Its text drafts cannot approve themselves or publish.
- Keep the Mac powered, connected, logged in and awake for collection. GitHub can drain its existing queue while the Mac is offline.
- Bail Money Radio is not connected or activated. Do not reuse RapWire credentials for it.

## Editorial independence and selection

The user authorizes independent discovery and selection. Use monitor/sources.json as the live collector source registry, not hard-coded lists in old prompts. Sources can be added after confirming the exact account from a publisher-owned website/profile and recording scope/evidence. A source identity check is not proof of its claims.

Hip-hop is the core: music, artists, performances, substantive culture and court developments. Gaming is occasional; hold a new gaming upload if another gaming story is among the latest six distinct posted records. Finish already-started deliveries safely.

The collector rotates at most two non-VIP source checks per cycle, with 30-minute source intervals; VIP sources are due every five minutes. Failed source checks back off fifteen minutes. Existing VIP discoveries from akademiks, traploreross and records remain durable, but are not exempt from factual review or quality checks. After a same-source streak, give alternatives priority. A saved in-flight upload retains its delivery slot.

Ranking combines visible views, current profile position and bounded learned performance. Missing view counts are not invented. Learned source weights start only after at least three measured posts and 500 reach/views, and can change a source weight only within 0.8–1.25. This does not promise virality or prove causation.

Deduplicate canonical shortcodes and exact normalized captions across sources. Do not treat a genuine new development as a duplicate merely because its opening sentence resembles an older story. Retain held records; never delete them or alter existing live posts.

## Reporting, captions and visuals

Use the exact caption attached to the captured canonical post, never surrounding comments or profile text. Keep raw evidence and source URL. Strip old Source commentary labels and leading source handles from pending public copy. Preserve artist mentions; add new handles only from verified records. End captions with @rapwire247. Do not invent eyewitness reporting, exclusive access, quotes or facts.

Court verdicts, sentences, arrests/charges, death reports and first-person investigative claims require an actual reporting review. Record news_verification with status verified, checked_at, claim_sha256 for the exact body, substantive notes, and at least two independent sources including url, publisher, supports and independent. An automated classifier or QA score is not fact verification. Case verification expires after 72 hours to catch later developments. Held items do not occupy active publishing slots. Review logs/editorial-inbox.json at the next newsroom run. Date older developments; distinguish allegations, pleas, convictions and sentences. Never use a blanket innocence disclaimer to contradict a known conviction.

Videos remain playable videos with matching complete audio, regular practical source size, H.264/AAC and no decorative card/border. Keep the compact logo bottom-left. Preserve faces, subtitles, titles, tweets and meaningful source text. Tweets/statements remain readable; a thumbnail cannot substitute for a playable video. Photos/carousels require complete ordered media, up to the supported ten API children. Keep appropriate source credit/provenance; branding does not turn somebody else's reporting into ours.

Threads copy includes at most one context-specific discussion prompt and stays within 500 characters including its footer. Preserve complete sentences. Ranking questions belong to music debates, not tragedies or verdict posts. If a source already asks a question, do not stack another. An unfit Threads caption stays held without blocking Instagram.

## Capacity, retries and state

Use the greater of confirmed rolling-day publications and Meta's reported quota usage. Reserve two slots below the effective platform limit. If Meta actually rejects at a lower limit, honor that observed ceiling for 24 hours instead of trusting a larger advertised number. Unknown capacity fails closed or uses the conservative policy fallback. No catch-up bursts.

Instagram Stories are currently disabled in the production workflow. Do not claim they are posting. Re-enabling them requires capacity planning because feed and Story publications share quota. Threads has no separate Story endpoint in this publisher.

Rate-limit errors start a 30-minute cooldown, doubling up to four hours and respecting a longer Retry-After. This is a retry time, not a promised platform reset. Publishing-quota exhaustion is checked hourly. Threads can continue when Instagram is blocked.

Save container IDs and publish intent before non-idempotent operations. If a response is lost, require reconciliation rather than blindly reposting. Verify returned media IDs and permalinks. A green workflow alone is not evidence a post exists. If saving state fails, the next run must hold publishing until the retained artifact is reconciled.

## Threads conversations and measurement

Reply only to eligible new comments on RapWire's own recent Threads posts. Verify the account identity. No unsolicited replies to unrelated users' posts, harassment, fake agreement, fabricated facts or repeated reply loops. Debate ranking criteria; agree when the actual comment supports agreement. Skip abusive, unrelated and sensitive comments. Limit to one reply per 30 minutes, twelve per day, two per person per day and one per person/root post per day. Read back the exact reply ID, text and parent. Uncertain outcomes stay pending for reconciliation.

Measure up to six recent posts per platform every six hours plus account follower counts. Instagram metrics are reach, likes, comments, shares and saves; Threads metrics are views, likes, replies, reposts and quotes. Unavailable permissions/metrics remain unavailable, not zero. Follower growth is account-wide, not attributed to a specific post. Selection learns gradually from meaningful interactions per 1,000 reach/views.

## Where to look

- GitHub Actions: https://github.com/Fulstak-apps/rapwire-instagram-publisher/actions/workflows/publish-instagram.yml
- queue/*.json: durable containers, publish markers, media IDs, source evidence and permalinks.
- logs/publisher-health.json: latest delivery, failures, quota and next eligibility.
- logs/instagram-cooldown.json and logs/instagram-publishing-quota.json: enforced account holds.
- logs/publish-attempts.jsonl: platform event ledger.
- logs/editorial-inbox.json: claims/captions requiring reporting.
- logs/growth-feedback.json and logs/growth-report.md: measured performance and missing permissions.
- logs/threads-replies.json: reply targets, verified IDs, rate limits and blockers.
- monitor/repost-ledger.json: source discovery, durable VIP backlog and collector errors.

## Tests

Run `node --test scripts/*.test.mjs` and `python3 -m unittest discover -s scripts -p test_local_rapwire.py`. Tests use fake platform responses, not live credentials. Observe a real deployment separately before claiming live feature success.
