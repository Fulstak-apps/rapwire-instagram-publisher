# RapWire Newsroom v2

Newsroom v2 adds a deterministic ranking layer in front of the existing local Ollama editor. The existing editor, QA gates, queue format, artwork workflow, and Meta publisher remain intact.

## What changes

Instead of sending every fresh acceptable feed item straight to Ollama, RapWire now scores the pool first and sends only a diversified high-signal shortlist.

Each candidate is evaluated on:

- freshness with a real time-decay curve rather than simple newest-first sorting;
- source-quality prior;
- cultural heat such as direct responses, diss records, reunions, surprise drops, chart/record moments, premieres, and major announcements;
- impact signals such as albums, tours, festivals, label/business moves, and collaborations;
- visual usefulness;
- optional upstream trend/velocity/engagement signals when collectors provide them;
- duplicate similarity;
- recent artist fatigue and same-batch repetition;
- lifestyle/fluff penalties;
- stronger handling of uncorroborated legal, death, violence, and allegation stories.

The output is explainable. Internally every ranked item receives `viral_score`, `viral_priority`, `viral_lane`, `viral_entity`, `viral_reasons`, and `duplicate_of` metadata.

## Run it

Use the new entrypoint anywhere the local editor is currently invoked:

```bash
python3 scripts/local-rapwire-v2.py --dry-run
```

For normal draft generation:

```bash
python3 scripts/local-rapwire-v2.py
```

The v2 entrypoint loads `local-rapwire.py`, replaces only its feed-selection step with the ranked shortlist, and then hands control back to the existing editor. No publishing behavior is bypassed.

## Tuning

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RAPWIRE_NEWSROOM_POOL` | `7` | Maximum candidates sent to Ollama after ranking/diversification |
| `RAPWIRE_VIRAL_MIN_SCORE` | `42` | Minimum score allowed into the shortlist |
| `RAPWIRE_ENTITY_COOLDOWN_HOURS` | `12` | Recent same-artist window used for fatigue penalties |
| `RAPWIRE_HISTORY_ITEMS` | `80` | Recent queue items inspected for repetition/duplicates |
| `RAPWIRE_NEWSROOM_DEBUG` | `0` | Set to `1` to print the top scores and reasons |
| `RAPWIRE_TENTPOLE_ARTISTS` | empty | Optional comma-separated additions to the modest artist-gravity prior |

Example aggressive-but-clean configuration:

```bash
export RAPWIRE_NEWSROOM_POOL=6
export RAPWIRE_VIRAL_MIN_SCORE=48
export RAPWIRE_ENTITY_COOLDOWN_HOURS=10
export RAPWIRE_NEWSROOM_DEBUG=1
python3 scripts/local-rapwire-v2.py --dry-run
```

## Why it should be faster

The ranking layer is standard-library Python. It filters and orders candidates before the expensive local-model evidence/selection pass, so the LLM sees fewer weak or repetitive stories. This also reduces prompt size and page-metadata work for candidates that never had a realistic chance of becoming the post.

## Safety behavior

Newsroom v2 does **not** suppress legitimate breaking legal or crime news. It prevents weakly sourced sensitive claims from receiving a top viral priority solely because the language is sensational. Corroborated or stronger-source stories can compete normally, and all existing downstream QA/publishing gates remain in force.
