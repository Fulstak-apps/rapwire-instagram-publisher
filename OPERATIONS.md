# RapWire operating rules

Updated September 3, 2026. This is the current contract; older thread prompts are historical.

## What runs

- Live checkout: `/Users/dw/Library/Application Support/RapWire/publisher-runtime`.
- Mac collector and GitHub dispatcher check every 120 seconds; overlapping runs are skipped. GitHub has a five-minute backup schedule, not an exact-start guarantee.
- New feed posts have a minimum ten-minute gap per platform, measured from confirmed publication. Slow processing or quota holds can delay delivery. Instagram and Threads have separate IDs, timers and retries.
- Codex runs the independent newsroom only at 9 a.m., noon and 5 p.m. America/Los_Angeles. Those existing runs research up to three strong stories, verify claims, prepare visuals and queue staggered delivery. No additional frequent Codex wakeups or model calls for routine reposts.
- The hourly Threads writer runs in the existing GitHub workflow without waking Codex. The workflow checks it every five minutes so a safely staged post can finish, but it confirms at most one original rap conversation prompt per hour. It is Threads-only and uses no model call.
- The legacy local Ollama editor runs hourly into ignored review/local-editor. The autonomous local newsroom is installed separately through `scripts/install-local-newsroom.sh`, runs about every five minutes, and uses `qwen3:4b` by default. It writes evidence drafts and may only produce `status=ready` after real local media and every existing publisher compatibility gate pass; incomplete work remains review-only.
- Keep the Mac powered, connected, logged in and awake for collection. GitHub can drain its existing queue while the Mac is offline.
- Bail Money Radio is not connected or activated. Do not reuse RapWire credentials for it.

## Editorial independence and selection

The user authorizes independent discovery and selection. Use monitor/sources.json as the live collector source registry, not hard-coded lists in old prompts. Sources can be added after confirming the exact account from a publisher-owned website/profile and recording scope/evidence. A source identity check is not proof of its claims.

Hip-hop is the core: music, artists, performances, substantive culture and court developments. Gaming is occasional; hold a new gaming upload if another gaming story is among the latest six distinct posted records. Finish already-started deliveries safely.

The collector rotates at most two non-VIP source checks per cycle. Fast-track hip-hop sources are due every ten minutes, ordinary sources every thirty minutes, and VIP sources every five minutes. Failed source checks back off fifteen minutes. Existing VIP discoveries from akademiks, traploreross and records remain durable, but are not exempt from factual review or quality checks. After a same-source streak, give alternatives priority. A saved in-flight upload retains its delivery slot.

Ranking combines visible views, current profile position, a bounded observed view-velocity signal and learned performance. The velocity signal is based only on two recorded visible view counts; missing counts never become a guessed trend. Learned source weights start only after at least three measured posts and 500 reach/views, and can change a source weight only within 0.8–1.25. This improves selection but does not promise virality or prove causation.

The current priority-artist roster is encoded in `scripts/artist-priority.mjs`. A fresh, eligible post naming one of those artists receives a transparent queue boost and is recorded with the matched artist name. This is a priority signal, not a waiver for relevance, duplicate checks, media validation, claim verification, or account limits. Broad culture clips and older videos continue rotating between priority stories.

`@darnellwilliams` has a hard maximum of two scheduled posts per America/Detroit calendar day. The collector retains extra discoveries but will not queue them; the publisher also refuses a third Instagram feed post. Existing live posts are never changed retroactively.

Deduplicate canonical shortcodes and exact normalized captions across sources. Do not treat a genuine new development as a duplicate merely because its opening sentence resembles an older story. Retain held records; never delete them or alter existing live posts.

## Reporting, captions and visuals

Use the exact caption attached to the captured canonical post, never surrounding comments or profile text. Keep raw evidence and source URL. Strip old Source commentary labels and leading source handles from pending public copy. Preserve artist mentions; add new handles only from verified records. End captions with @rapwire247. Do not invent eyewitness reporting, exclusive access, quotes or facts.

Court verdicts, sentences, arrests/charges, death reports and first-person investigative claims require an actual reporting review. Record news_verification with status verified, checked_at, claim_sha256 for the exact body, substantive notes, and at least two independent sources including url, publisher, supports and independent. An automated classifier or QA score is not fact verification. Case verification expires after 72 hours to catch later developments. Held items do not occupy active publishing slots. Review logs/editorial-inbox.json at the next newsroom run. Date older developments; distinguish allegations, pleas, convictions and sentences. Never use a blanket innocence disclaimer to contradict a known conviction.

Videos remain playable videos with matching complete audio, regular practical source size, H.264/AAC and no decorative card/border. Keep the compact logo bottom-left. Preserve faces, subtitles, titles, tweets and meaningful source text. Tweets/statements remain readable; a thumbnail cannot substitute for a playable video. Photos/carousels require complete ordered media, up to the supported ten API children. Keep appropriate source credit/provenance; branding does not turn somebody else's reporting into ours.

For every reposted video, remove only a separate source-logo/header/handle strip before resizing or generating background fill. Preserve the original source-written in-video caption, subtitles, titles and other meaningful copy whenever its boundary is clean. Records and Raplisted headers/handles must not appear in the render. If that header-only cut would leave an unclean result, recut to the measured actual-footage panel rather than publishing the source header; use the written post caption beneath the clip for the context. The only added video graphic is the compact bottom-left RapWire logo. Never use a percentage guess or cut through faces/meaningful text; a source with no measurable clean footage panel still needs review.

The local `footage-only-v1` renderer samples five points across each complete source video, combines static neutral-panel boundaries with local Apple Vision text/face geometry, and records the chosen pixel rectangle. It requires macOS/Xcode command-line Swift support, ffmpeg and ffprobe; no paid model call or extra Codex wakeup. This is conservative sampled validation, not a guarantee about every unseen frame. Keep the original unbranded mux under ignored `work/instagram-mirror/*-source.mp4`, source/output samples, crop observations and center-grid preview under `*-crop-review/`. Retain failures with their exact review reason. Each video, including a mixed-carousel child, carries source/output hashes and layout evidence. The publisher checks the actual output bytes before either platform uses them. Safely unstarted legacy standalone videos can be recaptured to a new immutable asset path; never replace assets or captions on a live or uncertain/in-flight post. Unproven mixed or started legacy records stay explicitly held for review.

Threads copy includes at most one context-specific discussion prompt and stays within 500 characters including its footer. Preserve complete sentences. Ranking questions belong to music debates, not tragedies or verdict posts. If a source already asks a question, do not stack another. An unfit Threads caption stays held without blocking Instagram.

The hourly Threads writer uses evergreen rap conversation starters only. It never presents a current event as fact, creates Instagram media, or turns court cases, deaths, injuries, or other sensitive events into engagement bait. In GitHub Actions its durable state is `logs/hourly-threads.json`, saved with the ordinary publication log; local use can set `RAPWIRE_HOURLY_THREADS_STATE` or use the default state path. It is checked by the existing five-minute workflow schedule, while the confirmed-post guard enforces the hourly limit.

## Growth format rules

- Lead with the actual moment and artist, never a source-page name. A caption must make sense on mute alongside the first video frame.
- Keep a clip full-size and playable. Never turn it into a narrow card, add decorative boxes, or hide useful subtitles behind branding.
- Use one compact RapWire mark at bottom-left only. It must not cover a face, subtitle, tweet, trailer title or primary action.
- When a current official artist handle is verified, caption the first artist mention as `Artist Name @officialhandle`. If not verified, use the artist name without guessing a handle. Never substitute a blog/source handle for an artist handle.
- Assign each new item a factual recurring series for measurement: `Case File`, `New Music Watch`, `From the Vault`, `RapWire Debate`, or `What Happened?`. Series is metadata and caption framing, not an intrusive visual box.
- Threads may add one specific, good-faith conversation prompt; Instagram keeps the complete caption. Ranking and catalog debates can be provocative, but never turn court allegations, deaths, injuries or other sensitive events into engagement bait.
- The weekly report compares shares, saves, comments/replies, reposts/quotes, reach/views and follower change by source, topic and series. Only sufficiently sampled results may adjust selection; no format is declared a winner from a single post.

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

Run `node --test scripts/*.test.mjs` and `python3 -m unittest discover -s scripts -p 'test_local_rapwire*.py'`. Run `python3 scripts/local-rapwire-autonomous.py --health` for local dependencies and `python3 scripts/local-rapwire-autonomous.py --dry-run` for a read-only proposed queue record. Tests use fake platform responses, not live credentials. Observe a real deployment separately before claiming live feature success.
