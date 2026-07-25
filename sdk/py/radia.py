"""Radia Python SDK — parity with sdk/ts/client.ts (Phase 7).

Thin wrappers over the public ``/v0`` API: exactly what an external agent uses, with no
privileged access. Standard library only (``urllib``), so ``pip install radia`` pulls nothing
else in and the SDK works on any Python 3.9+ without a build step — the minimal-dependency
invariant applied to the client side.

Typical use::

    from radia import RadiaClient, agent_loop

    client = RadiaClient()                      # $RADIA_URL, credential auto-resolved
    client.register_kind({"kind": "job", "indexedPaths": [{"path": "tag", "type": "keyword"}]})
    client.put({"kind": "job", "body": {"tag": "a"}})

    def handle(record, c):
        return {"kind": "job_result", "body": {"ok": True}}

    agent_loop(client, name="worker", templates=[{"kind": "job"}], handle=handle)
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence

__all__ = [
    "RadiaClient",
    "RadiaError",
    "agent_loop",
    "credentials_path",
    "resolve_token",
    "default_base",
]

DEFAULT_BASE = "http://127.0.0.1:7788"
KIND_DEF = "kind_def"


class RadiaError(Exception):
    """An RFC 9457 problem response from the space."""

    def __init__(self, status: int, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.status = status
        self.code = code
        self.detail = detail


# ---------------------------------------------------------------------------
# Credentials — mirrors src/credentials.ts so `radia dev` provisioning works here too.
# ---------------------------------------------------------------------------


def credentials_path() -> str:
    explicit = os.environ.get("RADIA_CREDENTIALS")
    if explicit:
        return explicit
    xdg = os.environ.get("XDG_STATE_HOME")
    if xdg:
        return os.path.join(xdg, "radia", "credentials.json")
    appdata = os.environ.get("APPDATA")
    if appdata:
        return os.path.join(appdata, "radia", "credentials.json")
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if home:
        return os.path.join(home, ".radia", "credentials.json")
    return os.path.join(".", ".radia-credentials.json")


def _base_key(base: str) -> str:
    from urllib.parse import urlparse

    u = urlparse(base)
    return f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else base.rstrip("/")


def resolve_token(base: str) -> Optional[str]:
    """``RADIA_TOKEN`` wins; otherwise the credential ``radia dev`` provisioned for this base."""
    explicit = os.environ.get("RADIA_TOKEN")
    if explicit:
        return explicit
    try:
        with open(credentials_path(), "r", encoding="utf-8") as fh:
            entry = json.load(fh).get(_base_key(base))
        return entry.get("token") if isinstance(entry, dict) else None
    except (OSError, ValueError, AttributeError):
        return None


def default_base() -> str:
    return os.environ.get("RADIA_URL") or DEFAULT_BASE


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class RadiaClient:
    """A client for one space. Thread-safe: it holds no per-request state."""

    def __init__(self, base: Optional[str] = None, token: Optional[str] = None, timeout: float = 30.0):
        self.base = (base or default_base()).rstrip("/")
        # `token=""` explicitly means "send nothing"; None means "resolve one".
        self.token = resolve_token(self.base) if token is None else (token or None)
        self.timeout = timeout

    def with_token(self, token: str) -> "RadiaClient":
        return RadiaClient(self.base, token, self.timeout)

    # -- transport --

    def _req(self, method: str, path: str, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Any:
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                text = res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8")
            try:
                problem = json.loads(text)
            except ValueError:
                problem = {}
            raise RadiaError(e.code, problem.get("title", "error"), problem.get("detail", text)) from None
        except urllib.error.URLError as e:
            raise RadiaError(0, "unreachable", f"cannot reach a space at {self.base}: {e.reason}") from None
        return json.loads(text) if text else None

    # -- health and discovery --

    def health(self) -> Dict[str, Any]:
        return self._req("GET", "/v0/health")

    def register_kind(self, definition: Dict[str, Any]) -> Dict[str, str]:
        """Declare a kind by putting a ``kind_def`` record. Kinds are records, not an endpoint."""
        key = "kind_def:" + json.dumps(definition, sort_keys=True, separators=(",", ":"))
        self.put({"kind": KIND_DEF, "body": definition}, idempotency_key=key)
        return {"kind": definition["kind"]}

    def list_kinds(self) -> List[Dict[str, Any]]:
        """Every declared kind — latest ``kind_def`` per name (a redeclaration is a successor)."""
        latest: Dict[str, Any] = {}
        for rec in self.query({"kind": KIND_DEF}, limit=1000):
            body = rec.get("body") or {}
            name = body.get("kind")
            if not name:
                continue
            prev = latest.get(name)
            if prev is None or prev[0] < rec["id"]:
                latest[name] = (rec["id"], body)
        return [v[1] for v in latest.values()]

    # -- artifacts (design-data-model 2.4) --

    def put_artifact(
        self,
        data: bytes,
        media_type: str = "application/octet-stream",
        filename: Optional[str] = None,
        parent_ids: Optional[List[str]] = None,
        taint: bool = False,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Store bytes and get back the ``artifact`` record that references them.

        The payload never travels inside a record body: the record carries
        ``{digest, mediaType, size}`` and routes like anything else.
        """
        hdrs = {"Content-Type": media_type}
        if filename:
            hdrs["X-Radia-Filename"] = filename
        if parent_ids:
            hdrs["X-Radia-Parent-Ids"] = ",".join(parent_ids)
        if taint:
            hdrs["X-Radia-Taint"] = "true"
        if idempotency_key:
            hdrs["Idempotency-Key"] = idempotency_key
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + "/v0/artifacts", data=data, headers=hdrs, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8")
            try:
                problem = json.loads(text)
            except ValueError:
                problem = {}
            raise RadiaError(e.code, problem.get("title", "error"), problem.get("detail", text)) from None

    def get_artifact(self, record_id: str) -> bytes:
        """An artifact's bytes by record id."""
        hdrs = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        req = urllib.request.Request(
            self.base + "/v0/artifacts/" + urllib.parse.quote(record_id), headers=hdrs, method="GET"
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8")
            try:
                problem = json.loads(text)
            except ValueError:
                problem = {}
            raise RadiaError(e.code, problem.get("title", "error"), problem.get("detail", text)) from None

    def artifact_capability(self, record_id: str) -> Dict[str, Any]:
        """A short-lived, single-artifact download capability, for a context that cannot send an
        Authorization header (an ``<img src>``). Returns ``{capability, expiresAt, url}``."""
        return self._req("POST", "/v0/artifacts/" + urllib.parse.quote(record_id) + "/capability")

    # -- records --

    def put(self, request: Dict[str, Any], idempotency_key: Optional[str] = None) -> Dict[str, str]:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._req("POST", "/v0/records", request, headers)

    def read_one(self, template: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        return self._req("POST", "/v0/records/read-one", template)

    def query(self, template: Dict[str, Any], limit: int = 100) -> List[Dict[str, Any]]:
        payload = dict(template)
        payload["limit"] = limit
        return self._req("POST", "/v0/records/query", payload)["records"]

    def get_record(self, record_id: str) -> Optional[Dict[str, Any]]:
        try:
            return self._req("GET", f"/v0/ops/records/{record_id}")
        except RadiaError as e:
            if e.status == 404:
                return None
            raise

    def get_lineage(self, record_id: str) -> List[Dict[str, Any]]:
        return self._req("GET", f"/v0/ops/records/{record_id}/lineage")["lineage"]

    def get_children(self, record_id: str) -> List[Dict[str, Any]]:
        return self._req("GET", f"/v0/ops/records/{record_id}/children")["children"]

    # -- claims --

    def take(
        self,
        selector: Dict[str, Any],
        lease_seconds: Optional[int] = None,
        require_untainted: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        payload = dict(selector)
        if lease_seconds is not None:
            payload["leaseSeconds"] = lease_seconds
        if require_untainted is not None:
            payload["requireUntainted"] = require_untainted
        return self._req("POST", "/v0/takes", payload)

    def ack(
        self,
        lease: Dict[str, Any],
        result: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._req("POST", "/v0/leases/ack", {"lease": lease, "result": result}, headers)

    def nack(
        self,
        lease: Dict[str, Any],
        backoff_seconds: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"lease": lease}
        if backoff_seconds is not None:
            body["backoffSeconds"] = backoff_seconds
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._req("POST", "/v0/leases/nack", body, headers)

    def release(self, lease: Dict[str, Any]) -> Dict[str, Any]:
        return self._req("POST", "/v0/leases/release", {"lease": lease})

    def renew(self, lease: Dict[str, Any], lease_seconds: Optional[int] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"lease": lease}
        if lease_seconds is not None:
            body["leaseSeconds"] = lease_seconds
        return self._req("POST", "/v0/leases/renew", body)

    # -- observability --

    def get_events(self, after: str = "0", limit: int = 200) -> List[Dict[str, Any]]:
        from urllib.parse import quote

        return self._req("GET", f"/v0/ops/events?after={quote(after)}&limit={limit}")["events"]

    def get_stats(self) -> List[Dict[str, Any]]:
        return self._req("GET", "/v0/ops/stats")["stats"]

    def diagnostics(self) -> Dict[str, Any]:
        return self._req("GET", "/v0/ops/diagnostics")

    # -- watches --

    def watch(self, template: Dict[str, Any], stop: Optional[threading.Event] = None) -> Iterator[Dict[str, Any]]:
        """Yield wakeups (``{seq, recordId, kind}``) for matching records that become available.

        Reconnects with the last cursor on a dropped stream; a 410 (cursor expired) restarts
        from the beginning. The cursor is opaque — echoed back verbatim, never parsed.
        """
        watch_id = self._req("POST", "/v0/watches", template)["watchId"]
        cursor: Optional[str] = None
        while stop is None or not stop.is_set():
            headers = {"Last-Event-ID": cursor} if cursor is not None else {}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            req = urllib.request.Request(f"{self.base}/v0/watches/{watch_id}/events", headers=headers)
            try:
                # No read timeout: an idle watch is silent apart from the server's keepalives.
                with urllib.request.urlopen(req) as res:
                    for frame in _sse_frames(res, stop):
                        if frame.get("id") is not None:
                            cursor = frame["id"]
                        if frame.get("data"):
                            yield json.loads(frame["data"])
            except urllib.error.HTTPError as e:
                if e.code == 410:
                    cursor = "0"  # cursor_expired: a real client catches up with a query first
                    continue
                time.sleep(0.3)
            except urllib.error.URLError:
                time.sleep(0.3)
            if stop is not None and stop.wait(0.2):
                return


def _sse_frames(res, stop: Optional[threading.Event]) -> Iterator[Dict[str, str]]:
    """Parse an SSE body into ``{id, data}`` frames. Ends when the stream closes."""
    frame: Dict[str, str] = {}
    for raw in res:
        if stop is not None and stop.is_set():
            return
        line = raw.decode("utf-8").rstrip("\n")
        if line == "":
            if frame:
                yield frame
                frame = {}
            continue
        if line.startswith(":"):
            continue  # comment / keepalive
        if line.startswith("id:"):
            frame["id"] = line[3:].strip()
        elif line.startswith("data:"):
            frame["data"] = line[5:].strip()


# ---------------------------------------------------------------------------
# agent_loop — parity with sdk/ts/loop.ts
# ---------------------------------------------------------------------------


def agent_loop(
    client: RadiaClient,
    name: str,
    templates: Sequence[Dict[str, Any]],
    handle: Callable[[Dict[str, Any], RadiaClient], Optional[Dict[str, Any]]],
    lease_seconds: int = 30,
    poll_seconds: float = 1.0,
    stop: Optional[threading.Event] = None,
    log: Optional[Callable[[str], None]] = None,
) -> None:
    """Claim-handle-settle loop, event-driven via watches with a poll fallback.

    Each claim runs under a fenced lease with a renewal heartbeat at lease/3, acks with a
    per-attempt idempotency key (so a retried ack after a dropped response is not double work),
    and nacks on error. Delivery is at-least-once: a handler with side effects must be
    idempotent at the effect boundary.
    """
    say = log or (lambda _m: None)
    stop = stop or threading.Event()
    wake = threading.Event()

    def watcher(kind: str) -> None:
        while not stop.is_set():
            try:
                for _ in client.watch({"kind": kind}, stop):
                    wake.set()
                return
            except RadiaError as e:
                if e.status == 403:
                    # Permanent: this run has no grant to watch the kind. Say so loudly once and
                    # fall back to polling — "silently slow" would be worse than "loudly wrong".
                    say(f"[{name}] watch on '{kind}' FORBIDDEN ({e.code}) — using the poll fallback")
                    return
                say(f"[{name}] watch on '{kind}' dropped: {e} — retrying")
                stop.wait(1.0)

    threads = []
    for kind in dict.fromkeys(t["kind"] for t in templates):
        t = threading.Thread(target=watcher, args=(kind,), daemon=True)
        t.start()
        threads.append(t)

    while not stop.is_set():
        claimed = None
        try:
            for template in templates:
                claimed = client.take({"template": template}, lease_seconds=lease_seconds)
                if claimed:
                    break
        except RadiaError as e:
            say(f"[{name}] take error: {e}")

        if not claimed:
            wake.wait(poll_seconds)
            wake.clear()
            continue

        lease = claimed["lease"]
        record = claimed["record"]
        beat = _Heartbeat(client, lease, lease_seconds)
        beat.start()
        try:
            result = handle(record, client)
            key = f"ack:{record['id']}:{lease['epoch']}"
            res = client.ack(lease, result, idempotency_key=key)
            if res.get("status") == "lease_lost":
                say(f"[{name}] fenced on {record['id'][-6:]} — duplicate work possible (at-least-once)")
            else:
                say(f"[{name}] {record['kind']} {record['id'][-6:]} -> ok")
        except Exception as e:  # noqa: BLE001 — any handler failure is a nack, never a loop crash
            try:
                client.nack(lease)
            except RadiaError:
                pass
            say(f"[{name}] {record['id'][-6:]} -> nack: {e}")
        finally:
            beat.stop()


class _Heartbeat:
    """Renew a lease at lease/3 until stopped. Failures are ignored: the fence is authoritative."""

    def __init__(self, client: RadiaClient, lease: Dict[str, Any], lease_seconds: int):
        self._client = client
        self._lease = lease
        self._interval = max(1.0, lease_seconds / 3.0)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._client.renew(self._lease, lease_seconds=int(self._interval * 3))
            except RadiaError:
                pass

    def stop(self) -> None:
        self._stop.set()
