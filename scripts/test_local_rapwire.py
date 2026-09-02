import importlib.util
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("local_editor", Path(__file__).with_name("local-rapwire.py"))
editor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = editor
spec.loader.exec_module(editor)


class LocalEditorTests(unittest.TestCase):
    def setUp(self):
        self.candidate = editor.Candidate("test", "New album announced", "Evidence", "https://example.com/news",
            datetime.now(timezone.utc).isoformat(), "complexmusic")
        self.copy = {"headline": "Artist announces a new album", "body": "word " * 30,
                     "caption": "A new album has been announced.", "featured_person": "Artist",
                     "content_format": "photo_news", "category": "music"}
        self.evidence = {"image_url": "https://example.com/image.jpg"}

    def test_valid_structure_is_not_publication_approval(self):
        _, qa = editor.qa_score(self.copy, self.candidate, self.evidence)
        self.assertTrue(qa["passed"])
        item = editor.queue_item(self.candidate, self.copy, self.evidence, qa)
        self.assertEqual(item["status"], "review")
        self.assertTrue(item["publish_blocked"])
        self.assertFalse(item["facts_verified"])
        self.assertEqual(item["slides"], [])

    def test_stale_source_cannot_pass_even_with_high_score(self):
        self.candidate.published_at = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        score, qa = editor.qa_score(self.copy, self.candidate, self.evidence)
        self.assertEqual(score, 90)
        self.assertFalse(qa["passed"])

    def test_future_source_blocked(self):
        self.candidate.published_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        self.assertFalse(editor.qa_score(self.copy, self.candidate, self.evidence)[1]["passed"])

    def test_invented_caption_handle_blocked(self):
        self.copy["caption"] = "Follow @madeupartist"
        self.assertFalse(editor.qa_score(self.copy, self.candidate, self.evidence)[1]["passed"])

    def test_source_handle_allowed(self):
        self.copy["caption"] = "Reported by @complexmusic"
        self.assertTrue(editor.qa_score(self.copy, self.candidate, self.evidence)[1]["passed"])

    def test_evidence_is_kept_without_refetching(self):
        with patch.object(editor, "build_evidence", return_value=self.evidence) as fetch:
            with patch.object(editor, "ollama_chat", return_value='{"index": 0}'):
                _, result = editor.choose_story([self.candidate])
        fetch.assert_called_once()
        self.assertEqual(result["source_evidence"], self.evidence)

    def test_invalid_model_indices_fail_closed(self):
        for raw in ('[]', '{"index": true}', '{"index": "0"}', '{"index": -1}', '{"index": 5}'):
            with self.subTest(raw=raw), patch.object(editor, "build_evidence", return_value=self.evidence):
                with patch.object(editor, "ollama_chat", return_value=raw), self.assertRaises(RuntimeError):
                    editor.choose_story([self.candidate])


if __name__ == "__main__":
    unittest.main()
