# RapWire Newsroom v2

Newsroom v2 adds a deterministic ranking layer in front of the existing local Ollama newsroom. The existing source registry, evidence gathering, QA gates, media pipeline, queue format, and Meta publisher remain intact.

## What changes

Instead of sending every fresh acceptable feed item straight to Ollama, RapWire scores the pool first and sends only a diversified high-signal shortlist.

Each candidate is evaluated on:

- freshness with a real time-decay curve rather than simple newest-first sorting;
- source-quality prior;
- cultural heat such as direct responses, diss records, reunions, surprise drops, chart/record moments, premieres, and major announcements;
- impact signals such as albums, tours, festivals, label/business moves, and collaborations;
- visual usefulness;
- optional upstream trend/velocity/engagement signals when collectors provide them;
- duplicate similarity;
- recent artist fatigue and same-batch repetition;
- lifestyle/fluff penalties in the general ranking layer;
- RapWire-specific bounded boosts for funny, meme, debate, reaction, clap-back, troll, and other social-culture moments;
- an occasional adult hip-hop culture/thirst-trap allowance that can rescue an otherwise eligible story without automatically making it top priority;
- stronger handling of uncorroborated legal, death, violence, and allegation stories.

RapWire culture boosts are disabled for sensitive stories and minor-related stories.

The output is explainable. Internally every ranked item receives `viral_score`, `viral_priority`, `viral_lane`, `viral_entity`, `viral_reasons`, and `duplicate_of` metadata.

## Production rollout

The production launchd service continues to call `scripts/run-local-newsroom.sh`. That runner now launches `scripts/local-rapwire-autonomous-v2.py`, which wraps the existing autonomous editor and changes only the candidate-ranking handoff. No new daemon or plist is required.

Read-only production-path test:

```bash
scripts/run-local-newsroom.sh --dry-run
```

Direct autonomous v2 dry run:

```bash
python3 scripts/local-rapwire-autonomous-v2.py --dry-run
```

Health check:

```bash
python3 scripts/local-rapwire-autonomous-v2.py --health
```

Re-running `scripts/install-local-newsroom.sh` installs/refreshes the existing launchd service and now health-checks the v2 autonomous path.

The older review-only editor also has a compatibility entrypoint:

```bash
python3 scripts/local-rapwire-v2.py --dry-run
```

## Tuning

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RAPWIRE_NEWSROOM_POOL` | `7` | General ranked candidate-pool target |
| `RAPWIRE_AUTONOMOUS_SHORTLIST` | `8` | Maximum candidates handed to the autonomous Ollama editor |
| `RAPWIRE_VIRAL_MIN_SCORE` | `42` | Minimum score allowed into the autonomous shortlist |
| `RAPWIRE_ENTITY_COOLDOWN_HOURS` | `12` | Recent same-artist window used for fatigue penalties |
| `RAPWIRE_HISTORY_ITEMS` | `100` | Recent queue items inspected for repetition/duplicates in the production runner |
| `RAPWIRE_NEWSROOM_DEBUG` | `0` | Set to `1` to print top scores and reasons |
| `RAPWIRE_TENTPOLE_ARTISTS` | empty | Optional comma-separated additions to the modest artist-gravity prior |

Example aggressive-but-clean dry run:

```bash
export RAPWIRE_AUTONOMOUS_SHORTLIST=6
export RAPWIRE_VIRAL_MIN_SCORE=48
export RAPWIRE_ENTITY_COOLDOWN_HOURS=10
export RAPWIRE_NEWSROOM_DEBUG=1
python3 scripts/local-rapwire-autonomous-v2.py --dry-run
```

## Why it should be faster

The ranking layer is standard-library Python. It filters, orders, deduplicates, and diversifies candidates before the expensive local-model evidence/selection pass, so Ollama sees fewer weak or repetitive stories. This reduces prompt size and avoids wasting later-stage work on candidates that had little chance of becoming the post.

Actual latency and engagement improvement should be measured from production logs; the ranking system improves selection mechanics but does not guarantee virality.

## Safety behavior

Newsroom v2 does **not** suppress legitimate breaking legal or crime news. It prevents weakly sourced sensitive claims from receiving a top viral priority solely because the language is sensational. Corroborated or stronger-source stories can compete normally, and all existing downstream reporting, QA, media, and publishing gates remain in force.
