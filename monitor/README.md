# RapWire 24/7 source monitor

This directory defines the monitoring contract for the RapWire newsroom. Keep routine reposting cheap and automatic: local/GitHub scripts should poll, capture, transcode, caption, queue, publish, and log repost videos without spending Codex or AI newsroom cycles. Reserve AI generation/research for real reported news, court cases, allegations, or explainers that need synthesis.

Lead accounts:
- @akademiks
- @traploreross
- @trapmatictv
- @raplisted_

Research-only news sources, used by the AI newsroom only when making factual explainer posts:
- @complexmusic
- @nojumper
- @poetikflakkonews
- @saycheesetv
- @worldstarhiphop
- @theshaderoom when directly rap-related
- @detroitrapnews
- @detroitrapdaily
- @gta6latest as the only occasional gaming exception

Important: this repository does not contain Instagram login credentials. Browser-based capture must use the dedicated signed-in Chrome profile on the user's Mac and must not export cookies. API credentials stay only in GitHub Actions secrets.

Cheap repost contract:
1. Every 10 minutes, attempt up to three repost-video publications before running any AI newsroom work.
2. Source videos from @trapmatictv, @raplisted_, @akademiks, and @traploreross only.
3. Mirror every eligible @trapmatictv video/repost and every eligible @raplisted_ video. For @akademiks and @traploreross, use their own Posts/Reels only unless the user changes the rule.
4. Download the playable video with audio and publish it as video, not as a screenshot carousel.
5. Preserve the regular source size, use full 1080px width whenever practical, and never shrink footage into a narrow card.
6. Put a compact RapWire 24/7 logo at the bottom or on already-empty video space without covering faces, subtitles, captions, trailer titles, or meaningful source text.
7. Remove blog/source @handles from the graphic. Omit written credit only for user-owned @trapmatictv and @raplisted_; otherwise keep source credit in the written caption.
8. Use simple template captions for reposts. Do not call AI just to write a routine repost caption.
9. Validate H.264/AAC, 1080x1350, duration, and center-grid preview before publishing.
10. Publish to Instagram and Threads, log both media IDs/permalinks, and retry only the failed platform on later runs.

News/explainer contract:
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
