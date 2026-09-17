"""The Python client, proved against a fake Branch Agent on this computer.

The fake is a real HTTP server on a free local port that writes down every request it gets and
answers from a small table, so each test can assert the exact method, address, headers and body
the client sent. Nothing here reaches the network beyond 127.0.0.1.

Run with: python3 -m unittest discover -s packages/sdk-python/tests
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from branch_agent import BranchClient, BranchError, from_data_dir  # noqa: E402

TOKEN = "a" * 64
RUN_ID = "11111111-2222-3333-4444-555555555555"
SSE = (
    'id: 1\nevent: run.started\ndata: {"id": 1, "kind": "run.started", "data": {}}\n\n'
    ": a comment line is ignored\n\n"
    'id: 2\nevent: tool.started\ndata: {"id": 2, "kind": "tool.started", "data": {"label": "Reading"}}\n\n'
    "event: broken\ndata: not json\n\n"
    'event: end\ndata: {"status": "completed"}\n\n'
)


class FakeBranch(BaseHTTPRequestHandler):
    """Answers the way Branch Agent does, and keeps a note of what it was asked."""

    def log_message(self, *args):
        pass

    def _record(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        entry = {
            "method": self.command,
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": json.loads(raw) if raw else None,
        }
        self.server.seen.append(entry)
        return entry

    def _send(self, status, value, content_type="application/json"):
        data = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _answer(self):
        entry = self._record()
        path = entry["path"]
        if entry["headers"].get("authorization") != f"Bearer {TOKEN}":
            return self._send(401, {"error": "Missing or invalid session token"})
        if path.startswith(f"/api/runs/{RUN_ID}/stream"):
            return self._send(200, SSE.encode("utf-8"), "text/event-stream")
        if path == "/api/moved":
            self.send_response(302)
            self.send_header("location", "http://127.0.0.1:9/elsewhere")
            self.end_headers()
            return None
        if path == "/api/plain-text-failure":
            return self._send(500, b"<html>broken</html>", "text/html")
        if path.startswith("/api/runs/0000"):
            return self._send(404, {"error": "Run not found"})
        if path == "/api/run" and not (entry["body"] or {}).get("prompt"):
            return self._send(400, {"error": "Give the task some words"})
        if path == "/api/run":
            return self._send(200, {"id": RUN_ID, "sessionId": "s-1", "status": "running"})
        if path.endswith("/yaml") and entry["method"] == "GET":
            return self._send(200, {"id": "f-1", "name": "Tidy", "yaml": "name: Tidy\n"})
        if path == f"/api/runs/{RUN_ID}":
            return self._send(200, {"run": {"id": RUN_ID, "status": "completed", "output": "Three lines."}})
        return self._send(200, {"ok": True, "path": path})

    do_GET = _answer
    do_POST = _answer
    do_DELETE = _answer


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBranch)
        cls.server.seen = []
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.server.seen.clear()
        self.branch = BranchClient(self.url + "/", TOKEN, timeout=5)

    def last(self):
        return self.server.seen[-1]

    def test_needs_an_address_and_a_key(self):
        with self.assertRaisesRegex(ValueError, "session key"):
            BranchClient(self.url, "")
        with self.assertRaisesRegex(ValueError, "session key"):
            BranchClient("", TOKEN)
        self.assertEqual(self.branch.url, self.url, "a trailing slash is not doubled up")
        self.assertNotIn(TOKEN, repr(self.branch), "the key is never shown")

    def test_the_key_is_never_sent_in_the_clear_or_to_a_file(self):
        for bad in ("file:///etc/passwd", "ftp://127.0.0.1", "http://example.com:3210", "http://192.168.1.4:3210"):
            with self.assertRaises(ValueError, msg=bad):
                BranchClient(bad, TOKEN)
        for good in ("http://localhost:3210", "http://[::1]:3210", "https://branch.example.com"):
            BranchClient(good, TOKEN)

    def test_reads_the_key_an_install_already_wrote(self):
        with tempfile.TemporaryDirectory() as data_dir:
            with open(os.path.join(data_dir, "session-token"), "w", encoding="utf-8") as handle:
                handle.write(TOKEN + "\n")
            branch = from_data_dir(data_dir, port=self.server.server_address[1])
            self.assertEqual(branch.state(), {"ok": True, "path": "/api/state"})
        self.assertEqual(self.last()["headers"]["authorization"], f"Bearer {TOKEN}")

    def test_start_a_task_stream_its_events_and_read_the_result(self):
        run = self.branch.runs.start("Summarise the meeting notes", temporary=True)
        self.assertEqual(run["id"], RUN_ID)
        sent = self.last()
        self.assertEqual((sent["method"], sent["path"]), ("POST", "/api/run"))
        self.assertEqual(sent["body"], {"prompt": "Summarise the meeting notes", "temporary": True})
        self.assertEqual(sent["headers"]["content-type"], "application/json")

        events = list(self.branch.runs.stream(run["id"], after=0))
        self.assertEqual([e["kind"] for e in events], ["run.started", "tool.started", "end"])
        self.assertEqual(events[1]["data"]["label"], "Reading")
        self.assertEqual(events[-1]["status"], "completed")
        sent = self.last()
        self.assertEqual(sent["path"], f"/api/runs/{RUN_ID}/stream?after=0")
        self.assertEqual(sent["headers"]["accept"], "text/event-stream")

        list(self.branch.runs.stream(run["id"], after=7))
        self.assertTrue(self.last()["path"].endswith("?after=7"), "a read picks up where one stopped")

        finished = self.branch.runs.get(run["id"])
        self.assertEqual(finished["run"]["output"], "Three lines.")
        self.assertEqual(self.last()["path"], f"/api/runs/{RUN_ID}")

    def test_steer_cancel_resume_and_approvals(self):
        self.branch.runs.steer(RUN_ID, "Keep it shorter.")
        self.assertEqual((self.last()["path"], self.last()["body"]), (f"/api/runs/{RUN_ID}/steer", {"text": "Keep it shorter."}))
        self.branch.runs.cancel(RUN_ID)
        self.assertEqual((self.last()["method"], self.last()["path"], self.last()["body"]), ("POST", f"/api/runs/{RUN_ID}/cancel", {}))
        self.branch.runs.resume(RUN_ID)
        self.assertEqual(self.last()["path"], f"/api/runs/{RUN_ID}/resume")

        self.branch.runs.approve("s-1", "allow")
        self.assertEqual(self.last()["path"], "/api/policy/approve")
        self.assertEqual(self.last()["body"], {"sessionId": "s-1", "decision": "allow", "remember": "session"})
        self.branch.policy.approve("s-1", "deny", "always")
        self.assertEqual(self.last()["body"]["remember"], "always")

        self.branch.policy.get()
        self.assertEqual((self.last()["method"], self.last()["path"]), ("GET", "/api/policy"))
        self.branch.policy.save(preset="read-only")
        self.assertEqual(self.last()["body"], {"preset": "read-only"})
        self.branch.policy.set_categories({"commands": "ask"})
        self.assertEqual((self.last()["path"], self.last()["body"]), ("/api/approvals/categories", {"commands": "ask"}))

    def test_memory_documents_sessions_and_schedules(self):
        self.branch.memory.search("Northgate")
        self.assertEqual((self.last()["path"], self.last()["body"]), ("/api/memory/search", {"query": "Northgate"}))
        self.branch.memory.search("Northgate", limit=3)
        self.assertEqual(self.last()["body"], {"query": "Northgate", "limit": 3})
        self.branch.search("invoice")
        self.assertEqual((self.last()["path"], self.last()["body"]), ("/api/retrieval/search", {"query": "invoice"}))

        self.branch.documents.add("Notes", "The invoice is due Friday.")
        self.assertEqual(self.last()["body"], {"name": "Notes", "text": "The invoice is due Friday."})
        self.branch.documents.remove("doc-1")
        self.assertEqual((self.last()["method"], self.last()["path"]), ("DELETE", "/api/documents/doc-1"))

        self.branch.sessions.follow_up("s-1", "And shorter.")
        self.assertEqual((self.last()["path"], self.last()["body"]), ("/api/sessions/s-1/followups", {"prompt": "And shorter."}))
        self.branch.schedules.trigger("daily")
        self.assertEqual(self.last()["path"], "/api/schedules/daily/trigger")

    def test_flows_and_flows_as_yaml(self):
        self.branch.flows.run("f-1", topic="invoices")
        self.assertEqual((self.last()["path"], self.last()["body"]), ("/api/flows/f-1/run", {"topic": "invoices"}))
        self.assertEqual(self.branch.flows.export_yaml("f-1"), "name: Tidy\n")
        self.assertEqual((self.last()["method"], self.last()["path"]), ("GET", "/api/flows/f-1/yaml"))
        self.branch.flows.import_yaml("name: Tidy\n")
        self.assertEqual((self.last()["path"], self.last()["body"]), ("/api/flows/yaml", {"yaml": "name: Tidy\n"}))
        self.branch.flows.list()
        self.assertEqual(self.last()["path"], "/api/flows")

    def test_an_id_cannot_reach_a_different_route(self):
        self.branch.sessions.get("../../api/secrets")
        self.assertEqual(self.last()["path"], "/api/sessions/..%2F..%2Fapi%2Fsecrets")

    def test_audit_filters_become_a_query(self):
        self.branch.audit(action="secret.used", limit=20, outcome=None, denied=True)
        self.assertEqual(self.last()["path"], "/api/audit?action=secret.used&limit=20&denied=true")
        self.branch.audit()
        self.assertEqual(self.last()["path"], "/api/audit")

    def test_a_refusal_is_a_branch_error_with_the_apps_wording(self):
        with self.assertRaises(BranchError) as caught:
            self.branch.runs.get("00000000-0000-0000-0000-000000000000")
        self.assertEqual((caught.exception.status, caught.exception.message), (404, "Run not found"))
        self.assertEqual(caught.exception.path, "/api/runs/00000000-0000-0000-0000-000000000000")
        with self.assertRaises(BranchError) as caught:
            self.branch.runs.start("")
        self.assertEqual(caught.exception.status, 400)
        with self.assertRaises(BranchError) as caught:
            BranchClient(self.url, "0" * 64).state()
        self.assertEqual(caught.exception.status, 401)
        with self.assertRaises(BranchError) as caught:
            self.branch.get("/api/plain-text-failure")
        self.assertEqual(caught.exception.message, "<html>broken</html>")

    def test_a_stream_that_is_refused_says_so(self):
        with self.assertRaises(BranchError) as caught:
            list(BranchClient(self.url, "0" * 64).runs.stream(RUN_ID))
        self.assertEqual(caught.exception.status, 401)

    def test_a_redirect_is_not_followed_so_the_key_stays_here(self):
        with self.assertRaises(BranchError) as caught:
            self.branch.get("/api/moved")
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual([s["path"] for s in self.server.seen], ["/api/moved"])

    def test_a_proxy_in_the_environment_never_sees_the_key(self):
        with mock.patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "no_proxy": ""}):
            branch = BranchClient(self.url, TOKEN, timeout=5)
            self.assertEqual(branch.tools()["path"], "/api/tools")

    def test_an_app_that_is_not_running_is_a_plain_error(self):
        with self.assertRaises(BranchError) as caught:
            BranchClient("http://127.0.0.1:9", TOKEN, timeout=2).state()
        self.assertEqual(caught.exception.status, 0)
        self.assertIn("could not be reached", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
