# RapWire 24/7 source monitor

This directory defines the cloud-monitoring contract for the RapWire newsroom. The monitor must poll only the configured lead accounts, normalize and deduplicate events, verify before enqueueing, and hand eligible stories to the existing publisher queue.

Lead accounts:
- @akademiks
- @nojumper
- @theshaderoom
- @tmz
- @traploreross
- @saycheesetv
- @detroitrapnews
- @detroitrapdaily
- @usacrime
- @poetikflakkonews
- @worldstarhiphop
- @gta6latest

Important: this repository does not contain Instagram login credentials. The always-on monitor must use an authorized data source/API or permitted public-feed provider and store secrets only in the hosting provider's secret manager. It must not scrape around access controls or use private account credentials.

Runtime contract:
1. Poll on a short interval.
2. Persist a cursor per source.
3. Normalize links, entities, timestamps, and claim fingerprints.
4. Deduplicate across sources and against the last 48 hours of RapWire posts.
5. Independently verify claims.
6. Obtain a documented reuse-permitted image.
7. Write one queue item with source handle, subject handle, source URL, rights basis, verification notes, graphic asset, caption, and publish-after time.
8. Publisher handles Instagram + Threads delivery.
9. Retry transient errors with exponential backoff and never duplicate an event.
10. Quarantine high-risk or unverified claims.
