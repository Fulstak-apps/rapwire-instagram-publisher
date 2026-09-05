#!/usr/bin/env python3
"""RapWire Newsroom v2 entrypoint.

Drop-in front door for the existing local Ollama editor. It keeps all existing draft
QA behavior, but ranks and diversifies the feed *before* Ollama sees it. This makes
selection faster, cheaper, less repetitive, and more likely to surface a high-signal
story instead of merely the newest acceptable item.
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
LOCAL_EDITOR = ROOT / "scripts" / "local-rapwire.py"
HISTORY_LIMIT = max(10, min(250, int(os.environ.get("RAPWIRE_HISTORY_ITEMS", "80"))))


def load_local_editor() -> Any:
    spec = importlib.util.spec_from_file_location("rapwire_local_editor", LOCAL_EDITOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {LOCAL_EDITOR}")
    module = importlib.util.module_from_spec(spec)
    # dataclasses and some reflection helpers expect the module to be registered.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def recent_queue_history() -> list[dict[str, Any]]:
    queue = ROOT / "queue"
    records: list[tuple[float, dict[str, Any]]] = []
    for path in queue.glob("*.json"):
        try:
            payload = json.loads(path.read_text())
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        # Normalize the fields the ranker uses without changing the queue item.
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


def install_ranked_feed(local_editor: Any) -> None:
    original_fetch = local_editor.fetch_feed

    def ranked_fetch() -> list[Any]:
        candidates = original_fetch()
        if not candidates:
            return []
        history = recent_queue_history()
        ranked = newsroom_engine.rank_objects(
            candidates,
            recent_stories=history,
            min_score=newsroom_engine.MIN_SCORE,
        )
        shortlist = newsroom_engine.select_diverse(
            ranked,
            limit=newsroom_engine.DEFAULT_SHORTLIST,
        )
        if newsroom_engine.DEBUG:
            print("RapWire Newsroom v2 ranking:", file=sys.stderr)
            for line in newsroom_engine.debug_lines(ranked):
                print("  " + line, file=sys.stderr)
        elif shortlist:
            best = shortlist[0].ranking
            print(
                f"RapWire Newsroom v2: {len(candidates)} candidates -> "
                f"{len(shortlist)}-story shortlist; top={best.priority}/{best.score:.1f}/{best.lane}",
                file=sys.stderr,
            )
        else:
            print(
                f"RapWire Newsroom v2: {len(candidates)} candidates, none cleared "
                f"viral floor {newsroom_engine.MIN_SCORE:.0f}.",
                file=sys.stderr,
            )
        return [entry.item for entry in shortlist]

    local_editor.fetch_feed = ranked_fetch


def main() -> int:
    local_editor = load_local_editor()
    install_ranked_feed(local_editor)
    return int(local_editor.main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
