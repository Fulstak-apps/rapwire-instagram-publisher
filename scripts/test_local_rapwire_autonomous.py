import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("local-rapwire-autonomous.py")
spec = importlib.util.spec_from_file_location("autonomous_editor", MODULE_PATH)
editor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = editor
spec.loader.exec_module(editor)


class AutonomousEditorTests(unittest.TestCase):
    def setUp(self):
        self.candidate = editor.Candidate(
            "guid-1", "Rapper announces a new album", "The artist announced the album and release date.",
            "https://www.instagram.com/complexmusic/p/ABC123/",
            datetime.now(timezone.utc).isoformat(), "complexmusic", "https://example.com/photo.jpg", 92, "music", "reported"
        )
        self.copy = {
            "headline": "Rapper announces a new album",
            "body": "The artist announced a new album and shared its release date with fans. " * 3,
            "caption": "The album announcement is here.", "threads_text": "The album announcement is here.",
            "featured_person": "Artist", "content_format": "photo_news", "category": "music",
            "tone": "straight", "confidence": "reported", "attribution_needed": False,
            "adult_thirst_trap": False,
        }
        self.evidence = {"image_url": "https://example.com/photo.jpg", "risk": "normal"}

    def test_source_registry_matches_production_file(self):
        configured = {x["handle"] for x in json.loads(editor.SOURCE_CONFIG.read_text())["sources"] if x.get("enabled")}
        self.assertEqual(configured, editor.APPROVED_SOURCE_HANDLES)

    def test_stale_and_future_sources_fail(self):
        for when in (datetime.now(timezone.utc) - timedelta(days=3), datetime.now(timezone.utc) + timedelta(hours=1)):
            self.candidate.published_at = when.isoformat()
            self.assertFalse(editor.qa_score(self.copy, self.candidate, self.evidence)[1]["passed"])

    def test_high_risk_claim_requires_attribution(self):
        evidence = {"image_url": "x", "risk": "high"}
        self.copy["confidence"] = "reported"
        self.assertFalse(editor.qa_score(self.copy, self.candidate, evidence)[1]["passed"])
        self.copy["caption"] = "According to the court filing, the artist was charged."
        self.assertTrue(editor.qa_score(self.copy, self.candidate, evidence)[1]["risk_attribution_ok"])

    def test_controversial_or_adult_flag_is_not_automatic_rejection(self):
        self.copy["tone"] = "debate"
        self.copy["adult_thirst_trap"] = True
        self.assertTrue(editor.qa_score(self.copy, self.candidate, self.evidence)[1]["passed"])

    def test_incomplete_draft_can_never_be_ready(self):
        _, qa = editor.qa_score(self.copy, self.candidate, self.evidence)
        with patch.object(editor, "AUTONOMOUS", True):
            item = editor.queue_item(self.candidate, self.copy, self.evidence, qa)
        self.assertEqual(item["status"], "review")
        self.assertTrue(item["publish_blocked"])
        self.assertFalse(item["publisher_compatibility"]["passed"])

    def test_unsupported_and_missing_media_fail_compatibility(self):
        ok, reasons = editor.publisher_compatibility({"content_type": "audio"})
        self.assertFalse(ok)
        self.assertIn("supported local media missing", reasons)
        item = {
            "source_policy_checked": True, "rap_relevance_checked": True,
            "content_claim_checked": True, "editorial_substance_checked": True,
            "text_overflow_checked": True, "content_type": "video", "video": "media/missing.mp4",
            "layout_template": "rapwire-video-grid-safe-v1",
            "video_layout": {"status": "validated", "source_sha256": "a", "output_sha256": "b"},
            "visual_asset_rights": "source_post_repost", "editorial_review_required": [],
        }
        self.assertFalse(editor.publisher_compatibility(item)[0])

    def test_dry_run_does_not_write_queue_or_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_queue, old_log = editor.QUEUE, editor.LOG_DIR
            editor.QUEUE, editor.LOG_DIR = Path(tmp) / "queue", Path(tmp) / "logs"
            try:
                response = {**self.copy, "index": 0, "source_evidence": self.evidence}
                with patch.object(editor, "fetch_feed", return_value=[self.candidate]), patch.object(editor, "choose_story", return_value=(self.candidate, response)):
                    with redirect_stdout(io.StringIO()):
                        self.assertEqual(editor.run_once(dry_run=True), 0)
                self.assertFalse(editor.QUEUE.exists())
                self.assertFalse(editor.LOG_DIR.exists())
            finally:
                editor.QUEUE, editor.LOG_DIR = old_queue, old_log

    def test_malformed_ollama_response_fails_closed(self):
        with patch.object(editor, "build_evidence", return_value=self.evidence), patch.object(editor, "ollama_chat", return_value=[]):
            with self.assertRaises(RuntimeError): editor.choose_story([self.candidate])

    def test_ollama_unavailable_fails_closed(self):
        with patch.object(editor.urllib.request, "urlopen", side_effect=editor.urllib.error.URLError("offline")):
            with self.assertRaises(RuntimeError): editor.ollama_chat("evidence")

    def test_runner_has_overlap_and_git_failure_guards(self):
        runner = (editor.ROOT / "scripts/run-local-newsroom.sh").read_text()
        self.assertIn('mkdir "$LOCK"', runner)
        self.assertIn("git fetch origin main", runner)
        self.assertIn("git rebase --autostash origin/main", runner)
        self.assertNotIn("git pull --rebase origin main || true", runner)
        self.assertNotIn("git push origin main || true", runner)

    def test_launchd_runs_every_five_minutes(self):
        plist = (editor.ROOT / "launchd/com.rapwire247.newsroom.plist").read_text()
        self.assertIn("<integer>300</integer>", plist)
        self.assertIn("run-local-newsroom.sh", plist)


if __name__ == "__main__":
    unittest.main()
