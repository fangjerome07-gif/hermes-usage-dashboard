#!/usr/bin/env python3
"""Demo server for the usage dashboard.

Serves the static frontend and replays sample JSON from ./fixtures, so the UI
can be opened without any of the real data-collection scripts. Standard
library only — `python3 mock_server.py` is enough.

The real project keeps one collector per data source and runs it as a
subprocess. This demo replaces that layer with static files while preserving
the same response contract:

    GET /api/<source>  ->  {"meta": {...}, "data": <collector output>}

Fixture dates are rebased on startup so the "last 7 days" views stay populated
whenever you run it.
"""

from __future__ import annotations

import argparse
import json
import re
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"

# source name -> fixture file
SOURCES = {
    "codex": "codex_quota.json",
    "wb": "workbuddy.json",
    "muse": "muse.json",
    "agy": "agy.json",
    "tavily": "tavily.json",
    "mac": "mac.json",
    "anchors": "anchors.json",
    "clash": "clash.json",
    "wb-throttles": "wb_throttles.json",
}

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/pure.js": ("pure.js", "application/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}

DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
EPOCH_MIN, EPOCH_MAX = 1_750_000_000, 1_900_000_000

_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()


def _walk_dates(obj):
    """Yield every date found in string values."""
    if isinstance(obj, dict):
        for value in obj.values():
            yield from _walk_dates(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk_dates(value)
    elif isinstance(obj, str):
        for m in DATE_RE.finditer(obj):
            try:
                yield date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                continue


def _shift(obj, delta_days: int):
    """Shift date strings and unix timestamps by delta_days."""
    if isinstance(obj, dict):
        return {k: _shift(v, delta_days) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_shift(v, delta_days) for v in obj]
    if isinstance(obj, str):
        def repl(m):
            try:
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                return m.group(0)
            return (d + timedelta(days=delta_days)).isoformat()
        return DATE_RE.sub(repl, obj)
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        if EPOCH_MIN < obj < EPOCH_MAX:
            return obj + delta_days * 86400
    return obj


# Each fixture carries the moment it was captured; that field is the anchor for
# rebasing every other timestamp, so "now" is always inside the sample window.
ANCHOR_FIELDS = {
    "codex": "snapshot_bj",
    "wb": "timestamp",
    "muse": "generated_at",
    "agy": "generated_at",
    "tavily": "generated_at",
    "mac": "generated_at",
    "anchors": "generated_at",
    "clash": "subscription.updated_at",
    "wb-throttles": "timestamp",
}


def _get_path(data: dict, path: str):
    cur = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _anchor_date(data: dict, name: str) -> date | None:
    value = _get_path(data, ANCHOR_FIELDS.get(name, ""))
    if isinstance(value, str):
        m = DATE_RE.search(value)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                pass
    return None


def load_fixture(name: str) -> dict:
    with _cache_lock:
        if name in _cache:
            return _cache[name]

    path = FIXTURES / SOURCES[name]
    data = json.loads(path.read_text(encoding="utf-8"))

    # Rebase dates so the capture time becomes today.
    today = datetime.now(timezone(timedelta(hours=8))).date()
    anchor = _anchor_date(data, name)
    if anchor is None:
        dates = list(_walk_dates(data))
        anchor = max(dates) if dates else None
    if anchor is not None:
        delta = (today - anchor).days
        if delta:
            data = _shift(data, delta)

    with _cache_lock:
        _cache[name] = data
    return data


def now_iso() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "UsageDashboardDemo/1.0"

    def log_message(self, fmt, *args):  # keep the console readable
        print("%s %s" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def do_GET(self):  # noqa: N802
        path = urlsplit(self.path).path

        if path in STATIC:
            filename, ctype = STATIC[path]
            file_path = ROOT / filename
            if not file_path.is_file():
                self._json(404, {"error": "static file missing", "file": filename})
                return
            self._send(200, file_path.read_bytes(), ctype)
            return

        if path.startswith("/api/"):
            name = path[len("/api/"):]
            if name not in SOURCES:
                self._json(404, {"error": "unknown source", "detail": name})
                return
            data = load_fixture(name)
            self._json(200, {
                "meta": {
                    "ok": True,
                    "fetched_at": now_iso(),
                    "fetched_epoch": datetime.now().timestamp(),
                    "from_cache": False,
                    "age_seconds": 0,
                    "stale": False,
                    "refresh_pending": False,
                    "demo": True,
                },
                "data": data,
            })
            return

        self._json(404, {"error": "not found", "path": path})


def main():
    parser = argparse.ArgumentParser(description="Run the usage dashboard demo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Demo dashboard: http://{args.host}:{args.port}")
    print("Sample data only — see fixtures/ and README.md")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
