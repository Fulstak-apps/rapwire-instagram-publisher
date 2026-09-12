#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import newsroom_engine

WRAPPER = SCRIPTS / "local-rapwire-autonomous-v2.py"
spec = importlib.util.spec_from_file_location("rapwire_autonomous_v2_tested", WRAPPER)
assert spec and spec.loader
v2 = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = v2
spec.loader.exec_module(v2)


class Dummy:
    def __init__(self, title: str, description: str = "") -> None:
        self.title = title
        self.description = description


def ranked(title: str, score: float = 30.0) -> newsroom_engine.RankedObject:
    ranking = newsroom_engine.StoryScore(
        score=score,
        priority="P4",
        lane="culture",
        reasons=("baseline",),
        entity="",
        duplicate_of="",
    )
    return newsroom_engine.RankedObject(Dummy(title), ranking)


class RapWireCultureTuningTests(unittest.TestCase):
    def test_adult_culture_moment_can_clear_floor_without_becoming_automatic_p1(self) -> None:
        tuned = v2.apply_rapwire_culture_tuning([ranked("Rapper posts a new thirst trap")])[0]
        self.assertEqual(tuned.ranking.score, 50.0)
        self.assertEqual(tuned.ranking.priority, "P3")
        self.assertTrue(any("adult-culture" in reason for reason in tuned.ranking.reasons))

    def test_sensitive_story_never_gets_social_heat_boost(self) -> None:
        tuned = v2.apply_rapwire_culture_tuning([ranked("Viral debate after rapper shooting report")])[0]
        self.assertEqual(tuned.ranking.score, 30.0)
        self.assertFalse(any("social heat" in reason for reason in tuned.ranking.reasons))

    def test_minor_related_story_never_gets_thirst_trap_boost(self) -> None:
        tuned = v2.apply_rapwire_culture_tuning([ranked("Underage 17-year-old thirst trap debate")])[0]
        self.assertEqual(tuned.ranking.score, 30.0)
        self.assertFalse(any("adult-culture" in reason for reason in tuned.ranking.reasons))

    def test_funny_or_debate_moments_receive_bounded_boost(self) -> None:
        tuned = v2.apply_rapwire_culture_tuning([ranked("Funny viral meme sparks rap debate")])[0]
        self.assertLessEqual(tuned.ranking.score, 40.0)
        self.assertGreater(tuned.ranking.score, 30.0)


if __name__ == "__main__":
    unittest.main()
