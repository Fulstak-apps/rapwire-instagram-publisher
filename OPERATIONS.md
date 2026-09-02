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

One Instagram container step per run, with feed/Story work alternating when both are waiting. One Threads step per run, independent of Instagram cooldown. These are checks, not a promise of one completed post every two minutes. No posts are deleted or edited.

Upload containers, publish-request markers and resulting media IDs are saved. Pending processing survives the next run. Explicit ERROR/EXPIRED responses get exponential retry delays; uncertain publish responses are held for reconciliation, never blindly duplicated. Old queue IDs are retained. A source shortcode/queue-ID duplicate is held without deleting the file.

Instagram rate-limit code 4 and related limits start a 30-minute cooldown, doubling for repeated limits up to four hours, honoring longer server Retry-After values. This is our retry window, not a guarantee that Meta resets its limit then. The local safety cap counts feed AND Story publications. A failed Story is retried; a failed Threads operation has its own retry timestamp.

## See what happened

[GitHub Actions](https://github.com/Fulstak-apps/rapwire-instagram-publisher/actions/workflows/publish-instagram.yml): open a run's Summary. The delivery summary distinguishes confirmed media IDs, waiting/cooldown, and failure. A green workflow alone is not proof a post exists.

- `logs/publisher-health.json`: latest full publishing-cycle result.
- `logs/instagram-cooldown.json`: next eligible Instagram retry time (UTC).
- `logs/publish-attempts.jsonl`: per-platform events.
- `queue/*.json`: authoritative per-item containers, IDs, verification and permalinks.
- Collector stdout/stderr: runtime `logs/repost-monitor.out.log` / `logs/repost-monitor.err.log`.
- Launcher stdout/stderr: `/tmp/rapwire-publisher.log` / `/tmp/rapwire-publisher.err`.
- Failed jobs retain a `publication-state-RUN_ID` artifact. If saving publication state fails, the next run creates a durable `logs/publication-state-hold.json` and refuses to publish. Reconcile that artifact and verify the missing media IDs before removing the hold; otherwise a successful remote post might be absent from the queue ledger.

## Verification

`node --test scripts/container-state.test.mjs scripts/publisher.integration.test.mjs`

The tests use fake platform responses, never live credentials. Live feed/Threads verification reads the returned media ID and records its permalink. Stories record a readback of the returned Story ID; there is no separate Threads Story publishing endpoint.
