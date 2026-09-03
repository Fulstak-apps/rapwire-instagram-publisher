# RapWire Instagram and Threads publisher

[OPERATIONS.md](OPERATIONS.md) is the current operating contract. It covers schedules, source discovery, original reporting, publishing limits, retries, visuals, replies and measured growth. Older thread prompts are historical.

Routine reposting is handled by local scripts and GitHub Actions, without frequent Codex wakeups. The newsroom runs only at the existing three daily times. Videos stay playable; photo/carousel captures retain every supported source item. Public captions must match the captured post.

## Required GitHub repository secrets

- INSTAGRAM_ACCESS_TOKEN
- INSTAGRAM_USER_ID
- THREADS_ACCESS_TOKEN
- THREADS_USER_ID

Never commit tokens or export browser cookies. Source capture uses the existing signed-in Mac browser profile. The public repository hosts the media URLs used by Meta.

## Current sources and reports

- [Source registry](monitor/sources.json)
- [Operating rules](OPERATIONS.md)
- [GitHub workflow](https://github.com/Fulstak-apps/rapwire-instagram-publisher/actions/workflows/publish-instagram.yml)
- logs/publisher-health.json: actual delivery IDs and blockers.
- logs/growth-report.md: measured engagement and follower changes, with unavailable data explicitly marked.
- logs/editorial-inbox.json: pending reporting and caption review.

A successful workflow is not proof of publication; verify each platform's media ID and permalink. Instagram Stories are currently disabled. Bail Money Radio remains unconnected.

## Development

Run `node --test scripts/*.test.mjs` and `python3 -m unittest discover -s scripts -p test_local_rapwire.py`.

The local Ollama editor writes text drafts for review only. It cannot approve claims or publish. Do not change a review draft to ready until facts, evidence, assets, source binding and layout checks are complete.
