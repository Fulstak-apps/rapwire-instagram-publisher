# RapWikip → RapWire Threads

This opt-in adapter runs inside the existing serialized publishing workflow.
It has no Instagram credentials, routes, or queue records. It uses no model calls.

Activation requires an approved X API access plan and a repository secret named
`X_BEARER_TOKEN`. Set repository variable `RAPWIRE_X_MIRROR_ENABLED=true` only after
approving any X API costs. The feature is disabled by default; no API subscription
has been purchased. Chrome sign-in is not an X API credential.

The first successful read saves the newest ten original posts (not pinned order,
replies, or reposts). Later reads use a durable since-ID cursor and pagination.
The existing dispatcher checks regularly; source reads are throttled to 15 minutes
and mirror publications to 30 minutes, leaving 20% of Threads quota unconsumed.
The main publishing cadence is unchanged. Actual timing depends on runner and Meta
processing availability. All state lives in `logs/x-rapwikip-state.json` and is saved
by the existing publication-state workflow with failure-artifact protection.

Text, images, playable MP4s, and ordered carousels are supported. Missing media,
polls, quoted context, and overlong captions are recorded for review rather than
silently truncated or replaced with thumbnails. Backfilled “today” captions carry
their original source date. X handles are preserved as source text, not verified
Threads identities. Uncertain publishes require reconciliation; never clear their
markers without checking Threads. Published IDs are the deduplication ledger.

Run `node --test scripts/x-threads-mirror.test.mjs` before enabling. After activation,
verify the first live Threads permalink and that no Instagram queue item was created.
