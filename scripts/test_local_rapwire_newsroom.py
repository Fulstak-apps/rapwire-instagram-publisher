#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

MODULE_PATH = Path(__file__).with_name("newsroom_engine.py")
spec = importlib.util.spec_from_file_location("newsroom_engine_tested", MODULE_PATH)
assert spec and spec.loader
newsroom = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = newsroom
spec.loader.exec_module(newsroom)


NOW = datetime(2026, 9, 4, 20, 0, tzinfo=timezone.utc)


def story(
    title: str,
    *,
    hours_old: float = 1,
    handle: str = "complexmusic",
    image: bool = True,
    description: str = "",
    source_count: int = 1,
    guid: str | None = None,
) -> dict:
    return {
        "guid": guid or title,
        "title": f"@{handle}: {title}",
        "description": description,
        "published_at": (NOW - timedelta(hours=hours_old)).isoformat(),
        "source_handle": handle,
        "link": f"https://example.com/{abs(hash(title))}",
        "image_url": "https://images.example.com/news.jpg" if image else "",
        "source_count": source_count,
    }


class NewsroomRankingTests(unittest.TestCase):
    def test_fresh_high_signal_story_beats_stale_routine_item(self) -> None:
        hot = story("Drake responds with a surprise new diss track", hours_old=0.5)
        routine = story("Artist announces album release date", hours_old=38)
        ranked = newsroom.rank_stories([routine, hot], now=NOW, min_score=0)
        self.assertEqual(ranked[0]["guid"], hot["guid"])
        self.assertGreater(ranked[0]["viral_score"], ranked[1]["viral_score"])

    def test_near_duplicate_is_heavily_penalized(self) -> None:
        first = story("Kendrick Lamar responds to Drake with new diss track", hours_old=0.5, guid="first")
        duplicate = story("Kendrick Lamar responds to Drake in a new diss track", hours_old=1, guid="duplicate")
        ranked = newsroom.rank_stories([first, duplicate], now=NOW, min_score=0)
        by_id = {item["guid"]: item for item in ranked}
        self.assertLess(by_id["duplicate"]["viral_score"], by_id["first"]["viral_score"])
        self.assertEqual(by_id["duplicate"]["duplicate_of"], "first")
        self.assertTrue(any("near-duplicate" in reason for reason in by_id["duplicate"]["viral_reasons"]))

    def test_uncorroborated_sensitive_claim_cannot_become_p1(self) -> None:
        risky = story(
            "Rapper reportedly arrested after alleged shooting",
            hours_old=0.1,
            handle="poetikflakkonews",
            description="Unconfirmed social-media report.",
            source_count=1,
        )
        score = newsroom.base_score(risky, now=NOW)
        self.assertLessEqual(score.score, 44.0)
        self.assertEqual(score.priority, "P4")
        self.assertTrue(any("capped" in reason for reason in score.reasons))

    def test_corroboration_allows_sensitive_story_to_compete_normally(self) -> None:
        verified = story(
            "Lil Durk trial gets a new federal court ruling",
            hours_old=0.2,
            handle="complexmusic",
            description="Court development confirmed by multiple sources.",
            source_count=3,
        )
        score = newsroom.base_score(verified, now=NOW)
        self.assertGreater(score.score, 44.0)
        self.assertNotIn("uncorroborated sensitive claim capped", score.reasons)

    def test_recent_entity_history_creates_fatigue_penalty(self) -> None:
        candidate = story("Drake announces a new single", hours_old=0.5, guid="new")
        history = [story("Drake drops another teaser", hours_old=2, guid="old")]
        without_history = newsroom.rank_stories([candidate], now=NOW, min_score=0)[0]
        with_history = newsroom.rank_stories([candidate], recent_stories=history, now=NOW, min_score=0)[0]
        self.assertLess(with_history["viral_score"], without_history["viral_score"])
        self.assertTrue(any("entity fatigue" in reason for reason in with_history["viral_reasons"]))

    def test_shortlist_prevents_one_artist_from_monopolizing_prompt(self) -> None:
        candidates = [
            story(f"Drake drops surprise track chapter {i}", hours_old=0.1 + i * 0.1, guid=f"drake-{i}")
            for i in range(5)
        ]
        candidates += [
            story("Doechii announces new tour", hours_old=1, guid="doechii"),
            story("Tyler the Creator premieres new video", hours_old=1.2, guid="tyler"),
        ]
        ranked = newsroom.rank_objects(candidates, now=NOW, min_score=0)
        selected = newsroom.select_diverse(ranked, limit=7)
        drake_count = sum(1 for item in selected if item.ranking.entity == "drake")
        self.assertLessEqual(drake_count, 2)
        self.assertTrue(any(item.ranking.entity == "doechii" for item in selected))
        self.assertTrue(any(item.ranking.entity == "tyler the creator" for item in selected))

    def test_output_is_explainable(self) -> None:
        ranked = newsroom.rank_stories([story("GloRilla drops surprise new single")], now=NOW, min_score=0)
        item = ranked[0]
        for field in ("viral_score", "viral_priority", "viral_lane", "viral_entity", "viral_reasons"):
            self.assertIn(field, item)
        self.assertIsInstance(item["viral_reasons"], list)
        self.assertGreater(len(item["viral_reasons"]), 0)


if __name__ == "__main__":
    unittest.main()
