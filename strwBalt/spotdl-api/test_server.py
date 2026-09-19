import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_work_dir = server.WORK_DIR
        server.WORK_DIR = Path(self.tmp.name)
        server._files.clear()
        server._progress.clear()
        self.client = server.app.test_client()

    def tearDown(self):
        server.WORK_DIR = self.old_work_dir
        self.tmp.cleanup()

    def test_health_is_available(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_rejects_missing_and_non_http_urls(self):
        self.assertEqual(self.client.post("/", json={}).status_code, 400)
        for url in ("file:///etc/passwd", "javascript:alert(1)", "not a url"):
            with self.subTest(url=url):
                self.assertEqual(self.client.post("/", json={"url": url}).status_code, 400)

    def test_rejects_large_requests(self):
        response = self.client.post(
            "/", data=b"x" * 16_385, content_type="application/octet-stream"
        )
        self.assertEqual(response.status_code, 413)

    def test_rejects_invalid_media_options(self):
        url = "https://open.spotify.com/track/123"
        self.assertEqual(self.client.post("/", json={"url": url, "audioFormat": "--help"}).status_code, 400)
        self.assertEqual(self.client.post("/", json={"url": url, "audioBitrate": "9999"}).status_code, 400)

    def test_enforces_active_job_limit(self):
        for i in range(server.MAX_ACTIVE_JOBS):
            server.set_progress(str(i), state="downloading")
        self.assertEqual(
            self.client.post("/", json={"url": "https://open.spotify.com/track/123"}).status_code,
            429,
        )

    def test_creates_valid_job_without_starting_download(self):
        with patch.object(server, "Thread") as thread:
            response = self.client.post(
                "/", json={"url": "https://open.spotify.com/track/123"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "job")
        thread.assert_called_once()


if __name__ == "__main__":
    unittest.main()
