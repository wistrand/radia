"""Thin client for the Radia extension HTTP bindings (``radia serve-ext`` / ``radia dev --ext``).

ZERO CHOREOGRAPHY by design (agent_docs/plan-extension-http.md): every method is one HTTP call,
and the fork checks, publish anchors, presence windows and digest hashing all run server-side in
the reference implementation. A method that grew a fork check or a digest here would be a second
implementation of a security boundary wearing a convenience wrapper; port the spec through
``extensions/conformance/`` instead. Standard library only, like ``radia.py``.

Typical use (the pip package stages this module as ``radia.ext``; from a checkout, import
``radia_ext``)::

    from radia import RadiaExt

    ext = RadiaExt("http://127.0.0.1:7788", token)   # co-hosted (--ext), or the serve-ext port
    ext.workspace_declare()
    w = ext.write_workspace("app", files={"main.py": "print(1)\\n"}, entrypoint="main.py")
    print(w["treeDigest"])
    print(ext.read_file("app", "main.py").decode())

The one convenience taken client-side: ``files`` values may be ``str`` or ``bytes``, split into
the route's ``files``/``filesBase64`` maps (encoding, not choreography).
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Union

__all__ = ["RadiaExt", "RadiaExtError"]


class RadiaExtError(Exception):
    """A problem response from the facade (or relayed from the space)."""

    def __init__(self, status: int, title: str, detail: str):
        super().__init__(f"{title}: {detail}")
        self.status = status
        self.title = title
        self.detail = detail


def _split_files(files: Dict[str, Union[str, bytes]]) -> Dict[str, Dict[str, str]]:
    text: Dict[str, str] = {}
    b64: Dict[str, str] = {}
    for path, contents in files.items():
        if isinstance(contents, bytes):
            b64[path] = base64.b64encode(contents).decode("ascii")
        else:
            text[path] = contents
    out: Dict[str, Dict[str, str]] = {}
    if text:
        out["files"] = text
    if b64:
        out["filesBase64"] = b64
    return out


def _clean(d: Dict[str, Any]) -> Dict[str, Any]:
    """Drop ``None`` values so an unset kwarg is an ABSENT field, never ``null`` the facade's
    unknown-field check has to reason about."""
    return {k: v for k, v in d.items() if v is not None}


class RadiaExt:
    def __init__(self, base: str, token: str, timeout: float = 30.0):
        """``timeout`` is per request, in seconds, matching ``RadiaClient``'s default: without one
        a dead facade hangs the caller forever. ``seed``/``result`` compute their own from the
        wait they asked for, so a long-poll is never cut short by the flat default."""
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout

    # -- transport -----------------------------------------------------------------------------

    def _call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, query: Optional[Dict[str, Any]] = None, raw: bool = False, timeout: Optional[float] = None) -> Any:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout if timeout is not None else self.timeout) as res:
                payload = res.read()
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                doc = json.loads(payload.decode("utf-8"))
            except Exception:
                doc = {}
            raise RadiaExtError(e.code, doc.get("title", "error"), doc.get("detail", payload.decode("utf-8", "replace"))) from None
        if raw:
            return payload
        return json.loads(payload.decode("utf-8")) if payload else None

    def health(self) -> Dict[str, Any]:
        return self._call("GET", "/ext/health")

    # -- workspace -----------------------------------------------------------------------------

    def workspace_declare(self) -> Dict[str, Any]:
        return self._call("POST", "/ext/workspace/v1/declare", {})

    def write_workspace(self, name: str, files: Dict[str, Union[str, bytes]], *, owner: Optional[str] = None, conversation_id: Optional[str] = None, attach: Optional[Dict[str, str]] = None, modes: Optional[Dict[str, str]] = None, ignore: Optional[List[str]] = None, entrypoint: Optional[str] = None, based_on: Optional[str] = None, taint: Optional[List[str]] = None, meta: Optional[Dict[str, Any]] = None, scope: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body = _clean({"name": name, "owner": owner, "conversationId": conversation_id, "attach": attach, "modes": modes, "ignore": ignore, "entrypoint": entrypoint, "basedOn": based_on, "taint": taint, "meta": meta, "scope": scope})
        body.update(_split_files(files))
        return self._call("POST", "/ext/workspace/v1/workspaces", body)

    def edit_workspace(self, name: str, *, edits: Optional[List[Dict[str, Any]]] = None, add: Optional[Dict[str, Union[str, bytes]]] = None, attach: Optional[Dict[str, str]] = None, modes: Optional[Dict[str, str]] = None, remove: Optional[List[str]] = None, entrypoint: Optional[str] = None, conversation_id: Optional[str] = None, meta: Optional[Dict[str, Any]] = None, scope: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body = _clean({"edits": edits, "attach": attach, "modes": modes, "remove": remove, "entrypoint": entrypoint, "conversationId": conversation_id, "meta": meta, "scope": scope})
        if add:
            split = _split_files(add)
            if "files" in split:
                body["add"] = split["files"]
            if "filesBase64" in split:
                body["addBase64"] = split["filesBase64"]
        return self._call("POST", "/ext/workspace/v1/workspaces/" + urllib.parse.quote(name, safe="") + "/edit", body)

    def list_workspaces(self, *, conversation_id: Optional[str] = None, scope: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/workspace/v1/workspaces", query=_clean({"conversationId": conversation_id, "scope": json.dumps(scope) if scope else None}))

    def read_workspace(self, name: str, *, conversation_id: Optional[str] = None, scope: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/workspace/v1/workspaces/" + urllib.parse.quote(name, safe=""), query=_clean({"conversationId": conversation_id, "scope": json.dumps(scope) if scope else None}))

    def read_file(self, name: str, path: str, *, conversation_id: Optional[str] = None, scope: Optional[Dict[str, Any]] = None) -> bytes:
        return self._call("GET", "/ext/workspace/v1/workspaces/" + urllib.parse.quote(name, safe="") + "/files/" + urllib.parse.quote(path), query=_clean({"conversationId": conversation_id, "scope": json.dumps(scope) if scope else None}), raw=True)

    def tree_digest(self, files: List[Dict[str, str]]) -> str:
        """Verify a digest server-side: ``files`` is ``[{path, digest, mode?}]``. The hash is
        normative and stays in the reference implementation on purpose."""
        return self._call("POST", "/ext/workspace/v1/digest", {"files": files})["treeDigest"]

    # -- capability ----------------------------------------------------------------------------

    def capability_declare(self) -> Dict[str, Any]:
        return self._call("POST", "/ext/capability/v1/declare", {})

    def publish_capability(self, tool_def: Dict[str, Any], *, provider: Optional[str] = None, scope: Optional[Dict[str, str]] = None, presence: bool = False) -> Dict[str, Any]:
        return self._call("POST", "/ext/capability/v1/publish", _clean({"def": tool_def, "provider": provider, "scope": scope, "presence": presence or None}))

    def retire_capability(self, tool: str, provider: str, *, supersedes: Optional[str] = None, scope: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        return self._call("POST", "/ext/capability/v1/retire", _clean({"tool": tool, "provider": provider, "supersedes": supersedes, "scope": scope}))

    def tools(self, *, scope: Optional[Dict[str, Any]] = None, presence_kind: Optional[str] = None, ttl_ms: Optional[int] = None, refresh_ms: Optional[int] = None, on_conflict: Optional[str] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/capability/v1/tools", query=_clean({"scope": json.dumps(scope) if scope else None, "presenceKind": presence_kind, "ttlMs": ttl_ms, "refreshMs": refresh_ms, "onConflict": on_conflict}))

    # -- presence ------------------------------------------------------------------------------

    def presence_declare(self, kind: str, *, ttl_ms: Optional[int] = None, refresh_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._call("POST", "/ext/presence/v1/declare", _clean({"kind": kind, "ttlMs": ttl_ms, "refreshMs": refresh_ms}))

    def beat(self, kind: str, subject: str, instance: str, *, ttl_ms: Optional[int] = None, refresh_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._call("POST", "/ext/presence/v1/beat", _clean({"kind": kind, "subject": subject, "instance": instance, "ttlMs": ttl_ms, "refreshMs": refresh_ms}))

    def retire_presence(self, kind: str, subject: str, instance: str, *, ttl_ms: Optional[int] = None, refresh_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._call("POST", "/ext/presence/v1/retire", _clean({"kind": kind, "subject": subject, "instance": instance, "ttlMs": ttl_ms, "refreshMs": refresh_ms}))

    def live_presence(self, kind: str, *, subject: Optional[str] = None, ttl_ms: Optional[int] = None, refresh_ms: Optional[int] = None, max_scan: Optional[int] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/presence/v1/live", query=_clean({"kind": kind, "subject": subject, "ttlMs": ttl_ms, "refreshMs": refresh_ms, "maxScan": max_scan}))

    # -- turn ----------------------------------------------------------------------------------

    def seed(self, kind: str, body: Any, *, key: Optional[str] = None, parent_ids: Optional[List[str]] = None, client_meta: Optional[Dict[str, Any]] = None, available_at: Optional[str] = None, deadline_at: Optional[str] = None, retention_until: Optional[str] = None, taint: Optional[List[str]] = None, result_kind: Optional[str] = None, timeout_ms: Optional[int] = None) -> Dict[str, Any]:
        # Refused, never dropped: a wait bound with nothing waiting on it is the misspelled-field
        # class the facade refuses server-side, reproduced client-side.
        if timeout_ms is not None and result_kind is None:
            raise ValueError("timeout_ms without result_kind: nothing would wait on it")
        req = _clean({"kind": kind, "body": body, "key": key, "parentIds": parent_ids, "clientMeta": client_meta, "availableAt": available_at, "deadlineAt": deadline_at, "retentionUntil": retention_until, "taint": taint})
        call_timeout = None
        if result_kind is not None:
            req["result"] = _clean({"kind": result_kind, "timeoutMs": timeout_ms})
            # The socket must outlive the long-poll it asked for (the facade's default wait is 30s).
            call_timeout = ((timeout_ms if timeout_ms is not None else 30_000) / 1000) + 15
        return self._call("POST", "/ext/turn/v1/seed", req, timeout=call_timeout)

    def result(self, seed_id: str, kind: str, *, timeout_ms: Optional[int] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/turn/v1/result", query=_clean({"seed": seed_id, "kind": kind, "timeoutMs": timeout_ms}), timeout=((timeout_ms or 0) / 1000) + 15)

    # -- permissions / promotion / host / compartment -------------------------------------------

    def scopes(self) -> Dict[str, Any]:
        return self._call("GET", "/ext/permissions/v1/scopes")

    def promotion_declare(self) -> Dict[str, Any]:
        return self._call("POST", "/ext/promotion/v1/declare", {})

    def promote(self, digest: str, tier: str, pins: List[Dict[str, Any]], *, kind: Optional[str] = None) -> Dict[str, Any]:
        return self._call("POST", "/ext/promotion/v1/promote", _clean({"digest": digest, "tier": tier, "pins": pins, "kind": kind}))

    def rollback(self, digest: str, tier: str, pins: List[Dict[str, Any]], *, kind: Optional[str] = None) -> Dict[str, Any]:
        return self._call("POST", "/ext/promotion/v1/rollback", _clean({"digest": digest, "tier": tier, "pins": pins, "kind": kind}))

    def pins(self, principal: str, tier: str, *, kind: Optional[str] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/promotion/v1/pins", query=_clean({"principal": principal, "tier": tier, "kind": kind}))

    def bindings(self, *, agent: Optional[str] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/host/v1/bindings", query=_clean({"agent": agent}))

    def compartment_audit(self, inside: List[str], *, field: Optional[str] = None) -> Dict[str, Any]:
        return self._call("GET", "/ext/compartment/v1/audit", query=_clean({"inside": ",".join(inside), "field": field}))
