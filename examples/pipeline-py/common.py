"""Shared plumbing for the Python pipeline example.

Imports resolve BOTH layouts: the pip package (`radia` package with `radia.ext`) and a checkout
(`sdk/py/radia.py` + `sdk/py/radia_ext.py`, put on sys.path here), so the example runs unchanged
from either. Everything else mirrors examples/pipeline/ (kinds.ts + tools.ts).
"""
import json
import pathlib
import sys

_SDK = pathlib.Path(__file__).resolve().parents[2] / "sdk" / "py"
if _SDK.is_dir():
    sys.path.insert(0, str(_SDK))

from radia import RadiaClient, RadiaError, agent_loop, credentials_path, default_base, resolve_token  # noqa: E402

try:
    from radia.ext import RadiaExt, RadiaExtError  # pip layout
except ImportError:
    from radia_ext import RadiaExt, RadiaExtError  # checkout layout

# Short-window presence, so killing a worker visibly drops its tool from `tools` within
# seconds. The default window is 15 minutes, sized for real fleets, not demos; the READER
# passes the same window, because liveness is the reader's question (extensions/ts/presence.ts).
PRESENCE_KIND = "pipeline_presence"
PRESENCE_TTL_MS = 10_000

TOOLS = {
    "upper": lambda s: str(s).upper(),
    "reverse": lambda s: str(s)[::-1],
    "wordcount": lambda s: len(str(s).split()),
}


def connect(base=None):
    """One acting credential for both halves: RadiaClient speaks /v0, RadiaExt speaks /ext/."""
    base = (base or default_base()).rstrip("/")
    token = resolve_token(base)
    if not token:
        # A `#login` entry is a PERSON's session half (`radia login`), which resolve_token
        # rightly skips: a session holds zero grants until an operator assigns some, and this
        # demo declares kinds and runs a fleet, so it bootstraps as the operator.
        hint = ""
        try:
            if f"{base}#login" in json.load(open(credentials_path())):
                hint = (
                    f"\n  A `radia login` session exists for {base}, but the demo needs the OPERATOR"
                    "\n  credential `radia dev` provisions (`radia serve` deliberately provisions none):"
                    "\n  it declares kinds and bootstraps a fleet, which a session's grants do not cover."
                )
        except Exception:  # noqa: BLE001. The hint must never mask the real error.
            pass
        raise SystemExit(
            f"no operator credential for {base}: start `deno task dev -- --ext` first, or set RADIA_TOKEN.{hint}"
        )
    return RadiaClient(base, token=token), RadiaExt(base, token)


def require_ext(ext):
    """The extension routes are co-hosted only when the space was started with --ext."""
    try:
        ext.health()
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            f"no extension routes at {ext.base}/ext/ : start the space with --ext\n"
            f"  (`deno task dev -- --ext`, or `radia dev --ext`). Underlying error: {e}"
        )


def register_kinds(client):
    """Same declarations as examples/pipeline/kinds.ts: the indexed paths are what let a worker
    claim {kind: pipeline_task, match: {op}} and the aggregator group results by job. The names
    are prefixed pipeline_* so the demo shares a space without claiming anybody else's task."""
    try:
        _register_kinds(client)
    except RadiaError as e:
        if e.code != "incompatible_redeclaration":
            raise
        # Another application on this space (e.g. `radia team`) already declared one of these
        # kind names with paths its live grants depend on. Superseding would break that app, so
        # the demo refuses alongside the runtime and points at an isolated space instead.
        raise SystemExit(
            "this space already uses the demo's kind names for another application:\n"
            f"  {e.detail}\n"
            "The demo will not supersede a live declaration. Run it against its own space:\n"
            "  RADIA_URL=http://127.0.0.1:7799 deno task demo:py"
        )


def _register_kinds(client):
    client.register_kind({"kind": "pipeline_job", "indexedPaths": []})
    client.register_kind({
        "kind": "pipeline_task",
        "indexedPaths": [{"path": "op", "type": "keyword"}, {"path": "jobId", "type": "keyword"}],
    })
    # result/summary are facts read by query, never taken -> claimable: false.
    client.register_kind({
        "kind": "pipeline_result",
        "indexedPaths": [{"path": "op", "type": "keyword"}, {"path": "jobId", "type": "keyword"}],
        "claimable": False,
    })
    client.register_kind({
        "kind": "pipeline_summary",
        "indexedPaths": [{"path": "jobId", "type": "keyword"}],
        "claimable": False,
    })
