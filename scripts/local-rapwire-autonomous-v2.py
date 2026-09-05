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


def install_newsroom_v2(editor: Any) -> None:
    original_fetch = editor.fetch_feed

    def ranked_fetch() -> list[Any]:
        candidates = original_fetch()
        if not candidates:
            return []
        ranked = newsroom_engine.rank_objects(
            candidates,
            recent_stories=recent_queue_history(),
            min_score=newsroom_engine.MIN_SCORE,
        )
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
