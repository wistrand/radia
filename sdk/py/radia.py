"""Radia Python SDK, at parity with sdk/ts/client.ts (Phase 7).

Thin wrappers over the public ``/v0`` API: exactly what an external agent uses, with no
privileged access. Standard library only (``urllib``), so ``pip install radia`` pulls nothing
else in and the SDK works on any Python 3.9+ without a build step. That is the minimal-dependency
invariant applied to the client side.

Typical use::

    from radia import RadiaClient, agent_loop

    client = RadiaClient()                      # $RADIA_URL, credential auto-resolved
    client.register_kind({"kind": "job", "indexedPaths": [{"path": "tag", "type": "keyword"}]})
    client.put({"kind": "job", "body": {"tag": "a"}})

    def handle(record, c):
        return {"kind": "job_result", "body": {"ok": True}}

    agent_loop(client, name="worker", patterns=[{"kind": "job"}], handle=handle)
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple, Union

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
# Credentials: mirrors src/credentials.ts so `radia dev` provisioning works here too.
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


def content_key(tag: str, body: Any) -> str:
    """An idempotency key that names the CONTENT, so a re-put of the same thing dedupes and a
    changed one is a new record.

    Key on CONTENT when writing the same thing twice must be free and writing something different
    must be a new record. Key on a logical IDENTITY (a subset of the body, written by hand) when a
    re-put must supersede -- that is what makes a ``retired: true`` tombstone replace the entry it
    withdraws rather than sit beside it. A key that names the container rather than the content
    dedupes writes that were meant to change something: the call returns 200 and nothing happened.

    Hashed because ``idem_key`` is part of a primary key and Postgres has a btree tuple limit.

    Always pass a body that is a pure function of the logical write: a timestamp in it makes every
    key unique, which turns the dedupe off as silently as naming the container turns it on.
    """
    return f"{tag}:{hashlib.sha256(_canonical(body).encode()).hexdigest()[:32]}"


def _canonical(v: Any) -> str:
    """Mirrors ``canonicalJson`` in ``sdk/ts/registry.ts``: object keys sorted, arrays in order,
    numbers rendered exactly as JavaScript renders them. The two SDKs MUST produce identical
    strings for the same body, or a TS writer and a Python writer key it differently and each
    writes its own record; ``conformance/py-parity.test.ts`` holds that contract.

    A value with no canonical JSON form (a set, a datetime, NaN, a non-string dict key) raises
    rather than being coerced: a silently stringified value keys on something JavaScript would
    never produce.
    """
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (int, float)):
        return _js_number(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str):
                raise TypeError(f"content_key: object key {k!r} is not a string")
        # JS sorts keys by UTF-16 code units; Python compares code points, and the two orders
        # disagree once a key mixes astral characters with U+E000..U+FFFF. Sort the UTF-16 form.
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{_canonical(v[k])}" for k in keys) + "}"
    raise TypeError(f"content_key: {type(v).__name__} has no canonical JSON form")


def _js_number(v: Any) -> str:
    """A number exactly as JavaScript's ``String(n)`` writes it (ECMA-262 Number::toString).

    Both languages already print shortest-round-trip digits; they disagree only on FORM. Python
    switches to exponent notation at 1e-5 and zero-pads the exponent (``1e-05``) where JavaScript
    keeps plain decimals down to 1e-6 and never pads (``0.00001``, ``1e-7``), so any body carrying
    a small float keyed differently until this reformatted it.

    An int beyond 2**53 is refused: JavaScript would round it, so no shared key can exist.
    """
    if isinstance(v, int):
        if abs(v) > 2 ** 53:
            raise ValueError(f"content_key: {v} exceeds double precision, JavaScript cannot represent it")
        return str(v)
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError("content_key: NaN/Infinity are not JSON")
    if v == 0:
        return "0"  # JSON.stringify(-0) is "0"
    sign = "-" if v < 0 else ""
    digits, n = _shortest_digits(-v if v < 0 else v)
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"


def _shortest_digits(x: float) -> Tuple[str, int]:
    """``(digits, n)`` with ``x == 0.digits * 10**n`` and no trailing zeros in ``digits``.

    ``repr`` already gives the shortest digit string for a positive finite float; this only
    reparses its three shapes (``123.456``, ``0.0001``, ``1.5e+300``) into spec form.
    """
    r = repr(x)
    if "e" in r:
        mantissa, _, exp = r.partition("e")
        digits = mantissa.replace(".", "")
        n = int(exp) + 1  # d.ddd * 10**X == 0.dddd * 10**(X+1)
    elif "." in r:
        int_part, _, frac = r.partition(".")
        if int_part == "0":
            stripped = frac.lstrip("0")
            n = len(stripped) - len(frac)
            digits = stripped
        else:
            digits = int_part + frac
            n = len(int_part)
    else:
        digits = r
        n = len(digits)
    return digits.rstrip("0") or "0", n


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


def _iso_seconds_from_now(iso: Optional[str]) -> Optional[float]:
    """Seconds until an ISO 8601 UTC instant, or None if it cannot be parsed. Never negative."""
    if not iso:
        return None
    try:
        from datetime import datetime, timezone

        when = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
    except ValueError:
        return None


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
        # A caller-supplied Authorization wins: minting a run authenticates with the DEFINITION
        # token, not this client's run token, so the client's credential must not overwrite it.
        if self.token and "Authorization" not in hdrs:
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

    def query_all(self, pattern: Dict[str, Any], max_pages: int = 40) -> List[Dict[str, Any]]:
        """Every record matching ``pattern``, newest-first, paged to EXHAUSTION.

        Registry-shaped reads -- capabilities, models, kinds, procedures, grants -- must never be a
        single bounded page. The server clamps ``limit`` to 500, so asking for more returns a silent
        prefix, and because a registry is read newest-first the records that fall off are exactly
        the ones that matter: a retirement, a redeclaration, the tool published a minute ago.

        Raises rather than returning a plausible prefix when the page budget is exhausted: a caller
        projecting a registry cannot tell a truncated answer from a complete one.
        """
        out: List[Dict[str, Any]] = []
        after: Optional[str] = None
        for _ in range(max_pages):
            rows = self.query(pattern, limit=500, after=after, dir="desc")
            out.extend(rows)
            if len(rows) < 500:
                return out
            after = rows[-1]["id"]
        raise RadiaError(
            0,
            "registry_incomplete",
            "more than {} records match {!r} - refusing to return a partial registry view".format(
                max_pages * 500, pattern
            ),
        )

    def list_kinds(self) -> List[Dict[str, Any]]:
        """Every declared kind: the latest ``kind_def`` per name (a redeclaration is a successor).

        Paged to exhaustion and newest-first: the server clamps ``limit`` to 500, so one bounded
        ascending read returns the OLDEST declarations and silently drops everything past the cap,
        rebuilding the view from declarations that have since been superseded. Retired kinds are
        dropped, matching the projection the runtime uses.
        """
        latest: Dict[str, Any] = {}
        for rec in self.query_all({"kind": KIND_DEF}):
            body = rec.get("body") or {}
            name = body.get("kind")
            if not name:
                continue
            # Newest = DB-assigned ``createdAt`` first, id only as the tie-break, matching
            # ``newer`` in sdk/ts/registry.ts. A ULID's timestamp is the writing PROCESS's clock,
            # so ordering by id alone puts two skewed instances' writes in the wrong order; the
            # id still decides inside one DB millisecond, where it carries real per-process order.
            order = ((rec.get("runtimeMeta") or {}).get("createdAt") or "", rec["id"])
            prev = latest.get(name)
            if prev is None or prev[0] < order:
                latest[name] = (order, body)
        # Retirement is applied AFTER newest-per-key, never as a filter over the input: filtering
        # first lets an older, non-retired record become "newest" and resurrect a withdrawn kind.
        return [v[1] for v in latest.values() if v[1].get("retired") is not True]

    # -- artifacts (design-data-model 2.4) --

    def put_artifact(
        self,
        data: bytes,
        media_type: str = "application/octet-stream",
        filename: Optional[str] = None,
        parent_ids: Optional[List[str]] = None,
        taint: bool = False,
        idempotency_key: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Store bytes and get back the ``artifact`` record that references them.

        The payload never travels inside a record body: the record carries
        ``{digest, mediaType, size}`` and routes like anything else.

        ``meta`` adds APPLICATION fields to that record body, so an app can route and scope the
        artifacts it owns. A grant pattern matches the body, and the rest of the body is computed
        by the runtime. Values must be scalars, and the object travels in a header, so it must be
        ASCII.
        """
        hdrs = {"Content-Type": media_type}
        if filename:
            hdrs["X-Radia-Filename"] = filename
        if meta:
            encoded = json.dumps(meta)
            # Fail here rather than deep in http.client, which raises an opaque encoding error
            # naming neither the header nor the value.
            if not encoded.isascii():
                raise ValueError("artifact meta must be ASCII: it travels in a header")
            hdrs["X-Radia-Meta"] = encoded
        if parent_ids:
            hdrs["X-Radia-Parent-Ids"] = ",".join(parent_ids)
        if taint:
            hdrs["X-Radia-Taint"] = "true"
        if idempotency_key:
            hdrs["Idempotency-Key"] = idempotency_key
        # A caller-supplied Authorization wins: minting a run authenticates with the DEFINITION
        # token, not this client's run token, so the client's credential must not overwrite it.
        if self.token and "Authorization" not in hdrs:
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

    # -- authorization: grants and the bootstrap chain (design-auth) --

    def grant(
        self,
        principal: str,
        kind: str,
        operations: List[str],
        pattern: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """Assign a kind-scoped grant. A grant IS a record, writable only by a human/supervisor
        principal; ``pattern`` narrows read/take to ``grant AND request``."""
        body: Dict[str, Any] = {"principal": principal, "kind": kind, "operations": operations}
        if pattern:
            body["pattern"] = pattern
        # CONTENT-KEYED, so re-assigning an unchanged grant writes nothing rather than appending a
        # duplicate on every run. But a grant that was RETIRED -- by a revocation, or by a
        # definition superseding it with a different pattern -- cannot be revived under that same
        # key: the write replays the retirement, so nothing is written while this reports success
        # and the principal still holds nothing. Key the revival on the record it supersedes, the
        # shape ``Space.createAgentDefinition`` uses.
        key = "grant:{}:{}:{}:{}".format(
            principal, kind, ",".join(sorted(operations)),
            json.dumps(pattern, sort_keys=True, separators=(",", ":")) if pattern else "",
        )
        want_ops = sorted(operations)
        try:
            # Newest first, so the first identity match IS the current state of that grant.
            rows = self.query(
                {"kind": "grant", "match": {"principal": principal, "kind": kind}}, 500, dir="desc"
            )
        except RadiaError:
            # A caller that may write grants but not read them cannot tell a retirement from a
            # fresh key. Best effort: fall back to the plain key.
            rows = []
        # Anchor on the NEWEST RETIREMENT of this identity, not on whether the newest record
        # happens to be retired. That keeps the key stable across repeats: once revived, calling
        # again reuses the revival's key and writes nothing, where anchoring on "newest is retired"
        # would fall back to the plain key the original record already consumed. A later retirement
        # moves the anchor, so the next revival is a fresh write.
        for row in rows:  # newest first
            b = row.get("body") or {}
            # A body carrying the pre-rename `template` field is a shape this build does not
            # understand; the runtime drops it from every projection, so it is not an identity
            # match here either.
            if "template" in b:
                continue
            if sorted(b.get("operations") or []) != want_ops:
                continue
            if (b.get("pattern") or None) != (pattern or None):
                continue
            if b.get("retired") is True:
                key += ":after:" + str(row["id"])
                break
        return self.put({"kind": "grant", "body": body}, idempotency_key=key)

    def create_agent_definition(
        self,
        agent: str,
        grants: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, str]:
        """Operator: define an agent with its grants. Returns the definition token, shown once."""
        return self._req("POST", "/v0/agent-definitions", {"agent": agent, "grants": grants or []})

    def create_run(self, definition_token: str, reuse: bool = False) -> Dict[str, Any]:
        """Mint a short-lived run token from a definition token.

        ``reuse`` returns the run this credential already holds when one is live, instead of
        minting another. A run is a permanent record, so a short-lived process that exchanges per
        invocation grows the space it is reading; leave it off for a worker fleet, where two
        processes sharing a run principal would be indistinguishable by author.
        """
        return self._req("POST", "/v0/agent-runs", {"reuse": bool(reuse)}, {"Authorization": f"Bearer {definition_token}"})

    def create_delegated_run(self, for_record_id: str) -> Dict[str, Any]:
        """Mint a DELEGATED run: this client's capability, bounded by its caller's reach.

        ``for_record_id`` names a record this client holds a lease on, or may read; the caller is
        resolved server-side from that record's author, so nothing here asserts an identity. The
        returned token is held BESIDE this client's own, never instead of it: use your own for your
        own capability, the delegated one for anything touching the caller's data.
        """
        return self._req("POST", "/v0/agent-runs/delegated", {"for": for_record_id})

    def delegated_client(self, for_record_id: str) -> "RadiaClient":
        """The same mint, as a second client. Holds no definition token, so it cannot outlive the
        run it was given: a delegated credential is scoped to a piece of work."""
        out = self.create_delegated_run(for_record_id)
        return RadiaClient(self.base, token=out["runToken"])

    def renew_run(self, run: str) -> Dict[str, Any]:
        """Extend this run's expiry, keeping the SAME token. Bounded by the run's max lifetime."""
        return self._req("POST", f"/v0/agent-runs/{urllib.parse.quote(run, safe='')}/renew")

    def keep_alive(self, stop: threading.Event, on_lost: Optional[Callable[[str], None]] = None) -> threading.Thread:
        """Renew this client's run token at HALF-LIFE until ``stop`` is set, in a daemon thread.

        Run tokens are short (~15 min) so a leaked one stops working, which means any long-running
        process must renew or it simply stops claiming and says nothing. Renewing at half-life
        rather than on a 401 is the point: by the time a call fails the session is already gone.
        ``on_lost`` fires when the run cannot be renewed (stopped, or past its ceiling) — neither is
        retryable, so a caller should stop working rather than spin.
        """

        def run_loop() -> None:
            while not stop.is_set():
                delay = 60.0
                try:
                    who = self.health()
                    principal = str(who.get("principal", ""))
                    if not principal.startswith("run:"):
                        return  # an operator token does not expire
                    expires = self.renew_run(principal).get("expiresAt")
                    left = _iso_seconds_from_now(expires)
                    delay = max(15.0, left / 2) if left else 60.0
                except RadiaError as e:
                    if e.status == 409:  # stopped, or past its maximum lifetime: not retryable
                        if on_lost:
                            on_lost(e.detail or "run cannot be renewed")
                        return
                    delay = 30.0
                stop.wait(delay)

        t = threading.Thread(target=run_loop, daemon=True)
        t.start()
        return t

    def revoke_definition(self, agent: str, reason: str = "") -> Dict[str, Any]:
        """Kill a definition token, permanently. Operator only.

        Existing runs are untouched and are separately revocable with `stop_run`: revoking stops
        new authority being handed out, it does not kill work in flight.
        """
        body: Dict[str, Any] = {"reason": reason} if reason else {}
        return self._req("POST", "/v0/agent-definitions/" + urllib.parse.quote(agent, safe="") + "/revoke", body)

    def stop_run(self, run: str) -> Dict[str, Any]:
        """Stop a run: its token stops resolving and its in-flight leases are invalidated."""
        from urllib.parse import quote

        return self._req("POST", f"/v0/agent-runs/{quote(run)}/stop")

    # -- records --

    def put(self, request: Dict[str, Any], idempotency_key: Optional[str] = None) -> Dict[str, str]:
        """Write a record. ``request`` is the wire shape: ``kind``, ``body``, and the optional
        client-submitted fields ``clientMeta``, ``parentIds``, ``taint``, ``deadlineAt``,
        ``retentionUntil`` and ``availableAt``.

        ``availableAt`` (ISO-8601) defers when the record becomes CLAIMABLE, and nothing fires at
        that instant: the record simply is not a take candidate until the database clock passes it,
        so a worker picks it up on its next poll. A value already past is clamped forward to now;
        one beyond the space's ceiling is refused with ``invalid_available_at``.
        """
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._req("POST", "/v0/records", request, headers)

    def read_one(self, pattern: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """ONE matching record, and it is the OLDEST one.

        With no ``order_by`` the order is the oracle's ``id`` tie-break, so a pattern matching
        several records answers with the first ever written. For anything that accumulates
        SUCCESSORS -- a registry entry, a versioned record -- that is the stale answer, silently.
        Use :meth:`read_newest`.
        """
        return self._req("POST", "/v0/records/read-one", pattern)

    def read_newest(self, pattern: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The NEWEST record matching ``pattern``, or ``None``.

        The safe half of the pair above and the one to reach for by default. Note the grant: this
        is a ``query``, not a ``read_one``, so a principal holding only ``read_one`` on the kind is
        refused. Ordering is a query.
        """
        rows = self.query(pattern, limit=1, dir="desc")
        return rows[0] if rows else None

    def query(
        self,
        pattern: Dict[str, Any],
        limit: int = 100,
        after: Optional[str] = None,
        dir: str = "asc",
    ) -> List[Dict[str, Any]]:
        return self.query_page(pattern, limit, after, dir)[0]

    def query_page(
        self,
        pattern: Dict[str, Any],
        limit: int = 100,
        after: Optional[str] = None,
        dir: str = "asc",
    ) -> Tuple[List[Dict[str, Any]], Optional[str], Optional[Dict[str, Any]]]:
        """One page, the cursor for the next, and the read's scope: ``(records, next_after, scope)``.

        ``scope`` is present only when a grant NARROWED this read (``{narrowedBy, ownRecordsOnly,
        note}``) and is ``None`` otherwise. Dropping it, as this method used to, leaves a scoped
        caller unable to tell its own slice from the whole space — the failure the server added the
        field to prevent, since a narrowed answer is shaped exactly like a complete one.

        ``after``/``dir`` are KEYSET pagination over record id: a cursor, not an offset, so a
        page stays correct while records are being written. Records come back in ASCENDING id
        order by default, which means a plain ``limit`` gives the OLDEST matches; pass
        ``dir="desc"`` for the newest. A cursor is defined for that natural order only: combining
        it with ``order_by`` is rejected, since a keyset over a body field would need the whole
        sort key. ``next_after`` is ``None`` on the last page.
        """
        payload = dict(pattern)
        payload["limit"] = limit
        if after is not None:
            payload["after"] = after
        if dir != "asc":
            payload["dir"] = dir
        r = self._req("POST", "/v0/records/query", payload)
        return r["records"], r.get("nextAfter"), r.get("scope")

    def get_record(self, record_id: str) -> Optional[Dict[str, Any]]:
        try:
            return self._req("GET", f"/v0/ops/records/{record_id}")
        except RadiaError as e:
            if e.status == 404:
                return None
            raise

    def get_lineage(self, record_id: str) -> List[Dict[str, Any]]:
        return self._req("GET", f"/v0/ops/records/{record_id}/lineage")["lineage"]

    def get_children(self, record_id: str, limit: int = 100, after: Optional[str] = None) -> List[Dict[str, Any]]:
        """One page of the records naming this one as a parent. BOUNDED: fan-out has no bound in
        principle, so walk it with ``get_children_page`` rather than assuming this is all of them."""
        return self.get_children_page(record_id, limit, after)[0]

    def get_children_page(
        self,
        record_id: str,
        limit: int = 100,
        after: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """One page of children plus the cursor for the next; ``next_after`` is ``None`` at the end.

        The endpoint has been paged since children became an indexed edge lookup; this method took
        no arguments, so a Python caller silently saw the first page of a fan-out and had no way to
        ask for the rest.
        """
        q = {"limit": str(limit)}
        if after:
            q["after"] = after
        path = f"/v0/ops/records/{urllib.parse.quote(record_id, safe='')}/children?{urllib.parse.urlencode(q)}"
        r = self._req("GET", path)
        return r["children"], r.get("nextAfter")

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

    def get_events_page(self, after: str = "0", limit: int = 200, tail: Optional[int] = None) -> Dict[str, Any]:
        """The whole page: events plus nextAfter, the scoped-withheld fields, and the event-GC
        truncation annotation (logBeginsAfter/sweptBefore) when the read started below the
        horizon. Prefer this over get_events when paging. tail=N returns the newest N events
        ascending with nextAfter always usable for following, which is how a live view starts."""
        from urllib.parse import quote

        q = f"tail={tail}" if tail is not None else f"after={quote(after)}&limit={limit}"
        return self._req("GET", f"/v0/ops/events?{q}")

    def get_stats(self) -> List[Dict[str, Any]]:
        return self._req("GET", "/v0/ops/stats")["stats"]

    def diagnostics(self) -> Dict[str, Any]:
        return self._req("GET", "/v0/ops/diagnostics")

    def erasures(self, undone: bool = False) -> Dict[str, Any]:
        """Every shred, and whether its payload is still gone.

        A shred destroys the runtime's copy, not the ability to store those bytes: the content
        address stays valid, so anyone holding the payload can write it again and every record
        referencing it reads once more. `holds: False` marks an erasure that was reversed.
        """
        return self._req("GET", "/v0/ops/erasures" + ("?undone=true" if undone else ""))

    def query_envelopes(
        self,
        state: str,
        expired: bool = False,
        stale: Optional[int] = None,
        limit: Optional[int] = None,
        kind: Optional[Union[str, Sequence[str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Records filtered by runtime ENVELOPE state, the dimension the content-routing query
        language deliberately omits, since that one matches record bodies for routing.

        ``expired`` keeps only leased rows whose lease has lapsed; ``stale`` keeps only
        first-attempt rows that have sat available that many seconds. ``kind`` keeps only those
        kinds, and is ANDed with whatever the caller's grants already scope this read to, so it can
        only narrow.

        Every predicate is applied before the cap, so ``limit`` bounds rows MATCHED rather than
        rows examined.
        """
        from urllib.parse import urlencode

        q: List[tuple] = [("state", state)]
        if expired:
            q.append(("expired", "1"))
        if stale is not None:
            q.append(("stale", stale))
        if limit is not None:
            q.append(("limit", limit))
        for k in ([kind] if isinstance(kind, str) else list(kind or [])):
            q.append(("kind", k))
        return self._req("GET", "/v0/ops/records?" + urlencode(q))["records"]

    # -- remediation (operator) --

    def admin(self, action: str, record_id: str) -> Dict[str, Any]:
        """Remediate ONE record: ``reclaim`` | ``dead-letter`` | ``requeue``."""
        from urllib.parse import quote

        return self._req("POST", f"/v0/ops/records/{quote(record_id)}/{action}")

    def remediate(
        self,
        action: str,
        state: str,
        expired: bool = False,
        stale: Optional[int] = None,
        limit: Optional[int] = None,
        kind: Optional[Union[str, Sequence[str]]] = None,
    ) -> Dict[str, Any]:
        """Remediate EVERY record matching an envelope selector. It takes the same selector
        :meth:`query_envelopes` does, so diagnosing and fixing use one vocabulary.

        Fixing a backlog one id at a time is a call per record, preceded by diagnostics calls just
        to learn the ids (and that report only samples ten). Returns ``{matched, applied, more}``;
        loop while ``more`` is true to drain a backlog::

            while True:
                r = client.remediate("reclaim", state="leased", expired=True)
                if not r["more"]:
                    break

        ``kind`` narrows it to one app's backlog. Naming a ``claimable: false`` kind is REFUSED
        (``kind_not_remediable``) rather than silently matching nothing: reference data sits
        available by design and is never stuck work.

        Every transition is state-guarded per record, so this is safe to re-run and safe to race a
        worker that comes back: a record that moved on is simply not applied.
        """
        body: Dict[str, Any] = {"action": action, "state": state}
        if expired:
            body["expired"] = True
        if stale is not None:
            body["stale"] = stale
        if limit is not None:
            body["limit"] = limit
        if kind is not None:
            body["kind"] = [kind] if isinstance(kind, str) else list(kind)
        return self._req("POST", "/v0/ops/remediate", body)

    def declassify(self, record_id: str, labels: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        """Privileged: emit a successor carrying the labels that were NOT cleared.

        ``labels`` names which to clear; omitted, it clears all of them. The answer reports
        ``cleared`` and ``remaining``, because a clearance that cannot say what it was FOR is the
        blanket the label vocabulary replaced.
        """
        from urllib.parse import quote

        body = {"labels": list(labels)} if labels is not None else None
        return self._req("POST", f"/v0/ops/records/{quote(record_id)}/declassify", body)

    # -- watches --

    def watch(self, pattern: Dict[str, Any], stop: Optional[threading.Event] = None) -> Iterator[Dict[str, Any]]:
        """Yield wakeups (``{seq, recordId, kind}``) for matching records that become available.

        Reconnects with the last cursor on a dropped stream; a 410 (cursor expired) restarts
        from the beginning. The cursor is opaque: echoed back verbatim, never parsed.

        Raises ``RadiaError`` when the space revokes the stream: a 401/403 on reconnect, or a
        ``revoked`` frame on a live one. The server re-checks the credential and the grants for as
        long as the stream runs, so both are terminal and retrying cannot fix either. Reconnecting
        would turn a revocation into a silent stall indistinguishable from an idle space.
        """
        watch_id = self._req("POST", "/v0/watches", pattern)["watchId"]
        cursor: Optional[str] = None
        while stop is None or not stop.is_set():
            if watch_id is None:  # re-create after the server forgot this watch (see the 404 below)
                try:
                    watch_id = self._req("POST", "/v0/watches", pattern)["watchId"]
                    cursor = None
                except RadiaError as e:
                    if e.status in (401, 403):
                        raise
                    time.sleep(0.3)
                    continue
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
                        # A named frame is control, never a wakeup. Without this branch `revoked`
                        # parses as a wakeup and is yielded as if a record had matched.
                        if frame.get("event") == "revoked":
                            raise RadiaError(
                                403, "forbidden", f"watch {watch_id} revoked: {frame.get('data', 'no reason given')}"
                            )
                        if frame.get("event") is None and frame.get("data"):
                            yield json.loads(frame["data"])
            except urllib.error.HTTPError as e:
                if e.code == 410:
                    cursor = "0"  # cursor_expired: a real client catches up with a query first
                    continue
                if e.code in (401, 403):
                    raise RadiaError(e.code, "forbidden", f"watch {watch_id} refused ({e.code})") from None
                if e.code == 404:
                    # Watches live in the server's memory, so a restart makes this id gone for good
                    # and retrying it is the one failure that never heals. Re-created at the top of
                    # the loop; events during the gap are missed by construction, which is what the
                    # caller's poll fallback is for.
                    watch_id = None
                    continue
                time.sleep(0.3)
            except urllib.error.URLError:
                time.sleep(0.3)
            if stop is not None and stop.wait(0.2):
                return


def _sse_frames(res, stop: Optional[threading.Event]) -> Iterator[Dict[str, str]]:
    """Parse an SSE body into ``{id, data, event}`` frames. Ends when the stream closes."""
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
        elif line.startswith("event:"):
            frame["event"] = line[6:].strip()


# ---------------------------------------------------------------------------
# agent_loop: parity with sdk/ts/loop.ts
# ---------------------------------------------------------------------------


def agent_loop(
    client: RadiaClient,
    name: str,
    patterns: Sequence[Dict[str, Any]],
    handle: Callable[..., Optional[Dict[str, Any]]],
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

    ``handle`` may take a THIRD parameter, ``fenced``: a ``threading.Event`` set the moment this
    claim's lease stops being ours (reclaimed, reassigned, or the run stopped). A handler with side
    effects should check it between steps and stop -- the design contract is that a fenced worker
    runs until it observes ``lease_lost``, and without this the only observation point was the
    final ack, i.e. after the work was already done. A two-parameter handler still works unchanged.
    """
    say = log or (lambda _m: None)
    # Failures go to the caller's ``log`` when it gave one, and to stderr when it did not. Never
    # nowhere: a swallowed handler exception is indistinguishable from a hang, since the record is
    # claimed, nacked, reclaimed and nacked again with nothing saying why. Matches `sdk/ts/loop.ts`.
    report = log or (lambda m: print(m, file=sys.stderr))
    stop = stop or threading.Event()
    wake = threading.Event()
    # Keep this run's credential alive for as long as the loop runs. Without it a Python worker
    # stopped claiming when its token lapsed (~15 minutes) and said nothing, so the failure looked
    # like an idle worker rather than a dead credential. It belongs here rather than in each agent:
    # any process running this loop is long-lived by definition.
    credential_lost: List[str] = []

    def credential_ended(reason: str) -> None:
        say(f"[{name}] credential ended: {reason}")
        credential_lost.append(reason)
        stop.set()

    client.keep_alive(stop, credential_ended)
    # A handler may take a third parameter, an Event set when this claim's lease stops being ours
    # (see _Heartbeat). Detected once, by signature, rather than by calling with three arguments
    # and catching TypeError: a TypeError raised INSIDE a two-argument handler is indistinguishable
    # from the arity mismatch, and would silently downgrade every later call.
    try:
        wants_fence = len(inspect.signature(handle).parameters) >= 3
    except (TypeError, ValueError):  # builtins and C callables have no introspectable signature
        wants_fence = False

    def watcher(kind: str) -> None:
        while not stop.is_set():
            try:
                for _ in client.watch({"kind": kind}, stop):
                    wake.set()
                return
            except RadiaError as e:
                if e.status == 403:
                    # Permanent: this run has no grant to watch the kind. Say so loudly once and
                    # fall back to polling. "Silently slow" would be worse than "loudly wrong".
                    report(f"[{name}] watch on '{kind}' FORBIDDEN ({e.code}): using the poll fallback")
                    return
                say(f"[{name}] watch on '{kind}' dropped: {e}. Retrying")
                stop.wait(1.0)

    threads = []
    for kind in dict.fromkeys(t["kind"] for t in patterns):
        t = threading.Thread(target=watcher, args=(kind,), daemon=True)
        t.start()
        threads.append(t)

    while not stop.is_set():
        claimed = None
        try:
            for pattern in patterns:
                claimed = client.take({"pattern": pattern}, lease_seconds=lease_seconds)
                if claimed:
                    break
        except RadiaError as e:
            report(f"[{name}] take error: {e}")

        if not claimed:
            wake.wait(poll_seconds)
            wake.clear()
            continue

        lease = claimed["lease"]
        record = claimed["record"]
        beat = _Heartbeat(client, lease, lease_seconds)
        beat.start()
        try:
            result = handle(record, client, beat.lost) if wants_fence else handle(record, client)
            if beat.lost.is_set():
                # The work finished, but somebody else owns the record now: settling is pointless
                # and the log has to say which of the two happened.
                say(f"[{name}] {record['id'][-6:]} finished after being fenced ({beat.reason}): not settled")
            else:
                key = f"ack:{record['id']}:{lease['epoch']}"
                res = client.ack(lease, result, idempotency_key=key)
                if res.get("status") == "lease_lost":
                    say(f"[{name}] fenced on {record['id'][-6:]}: duplicate work possible (at-least-once)")
                else:
                    say(f"[{name}] {record['kind']} {record['id'][-6:]} -> ok")
        except Exception as e:  # noqa: BLE001. Any handler failure is a nack, never a loop crash
            # A handler that stopped BECAUSE it was fenced must not be nacked: the lease is not
            # ours, so the nack fences out anyway and would only risk an attempt bump on the next
            # owner.
            if beat.lost.is_set():
                say(f"[{name}] {record['id'][-6:]} stopped on the fence ({beat.reason}): {e}")
            else:
                try:
                    client.nack(lease)
                except RadiaError:
                    pass
                report(f"[{name}] {record['id'][-6:]} -> nack: {e}")
        finally:
            beat.stop()
        if beat.reason == "credential":
            # Stopped or aged out: nothing this run holds can be settled, so stop claiming rather
            # than spin against a door that will not open.
            say(f"[{name}] credential ended: the run can no longer renew")
            break


class _Heartbeat:
    """Renew a lease at lease/3 until stopped, and REPORT the verdict instead of discarding it.

    The renew result used to be thrown away, so a reclaimed or quarantined worker went on renewing
    a dead lease for the life of the process while its handler kept producing side effects. Two
    outcomes are authoritative and stop the heartbeat:

    * ``{"status": "lease_lost"}`` -- the fence: somebody else owns the record now.
    * HTTP 401/403 -- this credential cannot renew, so it cannot settle the work either. A
      quarantined run arrives here rather than at ``lease_lost``, because stopping the run kills
      the token first.

    Anything else (a network blip, a 5xx) is transient and ignored: the lease has until its expiry,
    and guessing "lost" on a hiccup would cancel work that is still legitimately this worker's.
    """

    def __init__(self, client: RadiaClient, lease: Dict[str, Any], lease_seconds: int):
        self._client = client
        self._lease = lease
        self._interval = max(1.0, lease_seconds / 3.0)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        #: Set when the lease stops being ours. Handed to the handler as its cancellation channel.
        self.lost = threading.Event()
        #: ``"lease_lost"`` or ``"credential"``, once ``lost`` is set.
        self.reason: Optional[str] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                res = self._client.renew(self._lease, lease_seconds=int(self._interval * 3))
            except RadiaError as e:
                if e.status in (401, 403):
                    self._lose("credential")
                    return
                continue
            if (res or {}).get("status") == "lease_lost":
                self._lose("lease_lost")
                return

    def _lose(self, reason: str) -> None:
        self.reason = reason
        self.lost.set()
        self._stop.set()

    def stop(self) -> None:
        self._stop.set()
