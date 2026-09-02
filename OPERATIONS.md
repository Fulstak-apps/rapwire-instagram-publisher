# RapWire continuous publisher

## Runtime

- Local collector: `/Users/dw/Library/Application Support/RapWire/publisher-runtime`.
- Signed-in source browser profile remains in Application Support/RapWire/InstagramMirrorProfile. Never export its cookies.
- `com.rapwire.repost-monitor` checks every 120 seconds when the previous collection is finished.
- `com.rapwire.publisher` dispatches GitHub every 120 seconds unless a job is already active/queued. Its script must stay in Application Support, not the synced Documents tree.
- GitHub also has its supported five-minute backup schedule. Scheduled starts are not guaranteed exact by GitHub.
- `com.rapwire.keep-awake` runs `caffeinate -s`: prevents system sleep while connected to AC. Keep the Mac plugged in, lid open, connected and logged in. This does not keep a shut-down/offline Mac collecting; GitHub can still drain its existing queue.
- Codex health checks run only at the existing 09:00, 12:00 and 17:00 times. They do not generate newsroom stories or trigger extra reposts.

## Delivery and safety

New feed videos are spaced at least **30 minutes apart**, measured from the last confirmed feed publication and preserved across restarts. One Instagram container step per processing run, with feed/Story work alternating when both are waiting. One Threads step per run, independent of Instagram cooldown and feed cadence. The two-minute script checks advance uploads and cross-posts; they do not publish a fresh video every two minutes and do not wake Codex. Processing and capacity can delay a post beyond 30 minutes. There are no catch-up bursts. No posts are deleted or edited.

The conservative budget is **32 combined Instagram feed/Story publications per rolling 24 hours**, or 80% of a lower effective platform limit, whichever is lower. Use the higher of the local confirmed count and Meta's quota usage. Reserve capacity for every unfinished Story and the new video's matching Story before starting another feed item. This allows about 16 complete video/Story pairs per rolling day, fewer while clearing a Story backlog. It is not a promise of 48 videos plus 48 Stories daily. Threads has independent retry handling.

Threads accepts quality-validated ready videos before their Instagram delivery, so an Instagram quota hold does not stop coverage on both platforms. Each platform keeps its own confirmed-publication timer (minimum 30 minutes), media IDs, retries and reconciliation guards. A Threads-only success leaves the queue item's Instagram status ready. Resume the existing Threads container before opening another; never repost a confirmed Threads media ID when Instagram later succeeds.

A user-requested immediate recovery may name exactly one queue ID in `logs/instagram-recovery.json`, expiring within one hour. This allows only that feed/Story pair above the internal safety budget, never above a freshly verified platform limit. It requires a quota read less than five minutes old, no quota/cooldown block, normal feed pacing, and two platform slots remaining after the requested delivery. All quality and duplicate guards remain in place. It does not authorize a general backlog burst or reset quota usage.

Upload containers, publish-request markers and resulting media IDs are saved. Pending processing survives the next run. Explicit ERROR/EXPIRED responses get exponential retry delays; uncertain publish responses are held for reconciliation, never blindly duplicated. Old queue IDs are retained. A source shortcode/queue-ID duplicate is held without deleting the file.

Instagram rate-limit code 4 and related limits start a 30-minute cooldown, doubling for repeated limits up to four hours, honoring longer server Retry-After values. This is our retry window, not a guarantee that Meta resets its limit then. The local safety cap counts feed AND Story publications. A failed Story is retried; a failed Threads operation has its own retry timestamp.

Media Publish Limit Exceeded (9/2207042) is a separate account-wide publishing hold. Check capacity hourly while blocked; do not keep retrying publication every two minutes. If the published quota configuration disagrees with an actual rejection, honor the observed rejection ceiling until usage drops below it. The next check is not a promised reset time. Threads remains independent of the Instagram hold.

## Matching captions to videos

The collector reads the canonical shortcode and caption from the same post used for capture, never the surrounding article/comments. Captured complete media must uniquely match the visible video's duration and dimensions, with matching audio. Pending legacy items are repaired before new collection; already-live posts are not modified. Generic, missing, truncated or ambiguous captions are held for review, never replaced with filler. Verified artist handles come only from `monitor/artist-handles.json` and expire after 30 days. Source credit stays in the caption footer.

## See what happened

[GitHub Actions](https://github.com/Fulstak-apps/rapwire-instagram-publisher/actions/workflows/publish-instagram.yml): open a run's Summary. The delivery summary distinguishes confirmed media IDs, waiting/cooldown, and failure. A green workflow alone is not proof a post exists.

- `logs/publisher-health.json`: latest full publishing-cycle result.
- `logs/instagram-cooldown.json`: next eligible Instagram retry time (UTC).
- `logs/instagram-publishing-quota.json`: observed quota, enforced hold and next capacity check (UTC).
- `logs/publish-attempts.jsonl`: per-platform events.
- `queue/*.json`: authoritative per-item containers, IDs, verification and permalinks.
- Collector stdout/stderr: runtime `logs/repost-monitor.out.log` / `logs/repost-monitor.err.log`.
- Launcher stdout/stderr: `/tmp/rapwire-publisher.log` / `/tmp/rapwire-publisher.err`.
- Failed jobs retain a `publication-state-RUN_ID` artifact. If saving publication state fails, the next run creates a durable `logs/publication-state-hold.json` and refuses to publish. Reconcile that artifact and verify the missing media IDs before removing the hold; otherwise a successful remote post might be absent from the queue ledger.

## Verification

`node --test scripts/container-state.test.mjs scripts/publisher.integration.test.mjs scripts/video-caption.test.mjs scripts/media-ranges.test.mjs scripts/publication-policy.test.mjs`

The tests use fake platform responses, never live credentials. Live feed/Threads verification reads the returned media ID and records its permalink. Stories record a readback of the returned Story ID; there is no separate Threads Story publishing endpoint.
