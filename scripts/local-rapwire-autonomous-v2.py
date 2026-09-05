#!/usr/bin/env python3
"""RapWire autonomous newsroom with Newsroom v2 ranking installed.

This is a compatibility wrapper around local-rapwire-autonomous.py. It preserves the
existing autonomous discovery, evidence, QA, media, queue, health and dry-run behavior,
but replaces the feed handoff with Newsroom v2's stronger ranking/diversification.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any

import newsroom_engine

ROOT = Path(__file__).resolve().parents[1]
AUTONOMOUS_EDITOR = ROOT / "scripts" / "local-rapwire-autonomous.py"
HISTORY_LIMIT = max(10, min(250, int(os.environ.get("RAPWIRE_HISTORY_ITEMS", "100"))))
AUTONOMOUS_SHORTLIST = max(3, min(12, int(os.environ.get("RAPWIRE_AUTONOMOUS_SHORTLIST", "8"))))

# RapWire is not a business-paper feed. These are bounded culture signals layered on
# top of the general newsroom score so funny/debate/social moments can compete too.
# Sensitive stories never receive this boost, and anything involving minors is excluded.
SOCIAL_HEAT = {
    "funny": 5.0,
    "meme": 6.0,
    "debate": 5.0,
    "claps back": 6.0,
    "reacts": 3.0,
    "rant": 4.0,
    "troll": 4.0,
    "viral": 3.0,
    "wild": 3.0,
}
MINOR_TERMS = ("minor", "underage", "under-age", "15-year-old", "16-year-old", "17-year-old", "teen girl", "teen boy")


def load_autonomous_editor() -> Any:
    spec = importlib.util.spec_from_file_location("rapwire_autonomous_editor", AUTONOMOUS_EDITOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {AUTONOMOUS_EDITOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def recent_queue_history() -> list[dict[str, Any]]:
    records: list[tuple[float, dict[str, Any]]] = []
    queue = ROOT / "queue"
    if not queue.exists():
        return []
    for path in queue.glob("*.json"):
        try:
            payload = json.loads(path.read_text())
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        if not payload.get("title") and payload.get("headline"):
            payload["title"] = payload["headline"]
        if not payload.get("published_at"):
            payload["published_at"] = (
                payload.get("source_published_at")
                or payload.get("created_at")
                or payload.get("generated_at")
                or ""
            )
        records.append((path.stat().st_mtime, payload))
    records.sort(key=lambda pair: pair[0], reverse=True)
    return [payload for _, payload in records[:HISTORY_LIMIT]]


def _priority(score: float) -> str:
    if score >= 80:
        return "P1"
    if score >= 65:
        return "P2"
    if score >= 50:
        return "P3"
    return "P4"


def _candidate_blob(item: Any) -> str:
    title = str(getattr(item, "title", ""))
    description = str(getattr(item, "description", ""))
    return f"{title} {description}".casefold()


def apply_rapwire_culture_tuning(ranked: list[newsroom_engine.RankedObject]) -> list[newsroom_engine.RankedObject]:
    tuned: list[newsroom_engine.RankedObject] = []
    for entry in ranked:
        ranking = entry.ranking
        blob = _candidate_blob(entry.item)
        boost = 0.0
        reasons = list(ranking.reasons)
        sensitive = any(term in blob for term in newsroom_engine.SENSITIVE_TERMS)
        minor_related = any(term in blob for term in MINOR_TERMS)

        if not sensitive and not minor_related:
            social = min(10.0, sum(weight for term, weight in SOCIAL_HEAT.items() if term in blob))
            if social:
                boost += social
                reasons.append(f"RapWire social heat +{social:.0f}")

            # The general engine treats most lifestyle copy as low-value. RapWire can
            # occasionally run a clearly adult hip-hop thirst-trap/culture moment, so
            # neutralize that blanket penalty without making it an automatic top story.
            if "thirst trap" in blob:
                boost += 20.0
                reasons.append("RapWire adult-culture allowance +20")

        score = max(0.0, min(100.0, ranking.score + boost))
        tuned_ranking = newsroom_engine.StoryScore(
            round(score, 1),
            _priority(score),
            ranking.lane,
            tuple(reasons),
            ranking.entity,
            ranking.duplicate_of,
        )
        tuned.append(newsroom_engine.RankedObject(entry.item, tuned_ranking))

    tuned.sort(key=lambda entry: entry.ranking.score, reverse=True)
    return tuned


def install_newsroom_v2(editor: Any) -> None:
    original_fetch = editor.fetch_feed

    def ranked_fetch() -> list[Any]:
        candidates = original_fetch()
        if not candidates:
            return []
        # Rank everything first so RapWire-specific culture tuning can rescue an
        # otherwise valid social story before the viral floor is applied.
        ranked = newsroom_engine.rank_objects(
            candidates,
            recent_stories=recent_queue_history(),
            min_score=0,
        )
        ranked = apply_rapwire_culture_tuning(ranked)
        ranked = [entry for entry in ranked if entry.ranking.score >= newsroom_engine.MIN_SCORE]
        shortlist = newsroom_engine.select_diverse(ranked, limit=AUTONOMOUS_SHORTLIST)

        # Preserve the Candidate contract expected by the existing autonomous editor,
        # but make its exposed deterministic score/lane match the better v2 ranking.
        for entry in shortlist:
            if hasattr(entry.item, "score"):
                entry.item.score = int(round(entry.ranking.score))
            if hasattr(entry.item, "lane"):
                entry.item.lane = entry.ranking.lane

        if newsroom_engine.DEBUG:
            print("RapWire autonomous Newsroom v2 ranking:", file=sys.stderr)
            for line in newsroom_engine.debug_lines(ranked):
                print("  " + line, file=sys.stderr)
        elif shortlist:
            top = shortlist[0].ranking
            print(
                f"RapWire Newsroom v2: {len(candidates)} eligible -> {len(shortlist)} shortlisted; "
                f"top={top.priority}/{top.score:.1f}/{top.lane}",
                file=sys.stderr,
            )
        else:
            print(
                f"RapWire Newsroom v2: {len(candidates)} eligible, none cleared "
                f"viral floor {newsroom_engine.MIN_SCORE:.0f}.",
                file=sys.stderr,
            )
        return [entry.item for entry in shortlist]

    editor.fetch_feed = ranked_fetch


def main() -> int:
    editor = load_autonomous_editor()
    install_newsroom_v2(editor)
    return int(editor.main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
