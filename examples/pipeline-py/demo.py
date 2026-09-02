"""End-to-end pipeline demo on the Python SDKs (`python3 examples/pipeline-py/demo.py`).

A planner + two workers + an aggregator run as threads against a space over HTTP, the coordinator
seeds a job plus a standalone task through the extension bindings, and the run ends with the
summary, the event log and the summary's lineage. Prefers a space you already have open (started
with --ext) so the run shows up in its web console Feed tab; with none running it starts one and
leaves it up (Ctrl-C to stop). Pass --once to spawn an ephemeral space, run, and exit: that is
the self-contained smoke.
"""
import os
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request

from common import RadiaClient, RadiaExt, connect, register_kinds, require_ext, resolve_token
from aggregator import aggregator_loop
from coordinator import seed_and_await, wait_for_ops
from planner import planner_loop
from worker import worker_loop

ROOT = pathlib.Path(__file__).resolve().parents[2]
ONCE = "--once" in sys.argv
URL = os.environ.get("RADIA_URL", "http://127.0.0.1:7788").rstrip("/")
PACE = 0.0 if ONCE else float(os.environ.get("RADIA_DEMO_PACE", "500")) / 1000


def healthy():
    try:
        with urllib.request.urlopen(URL + "/v0/health", timeout=2):
            return True
    except Exception:  # noqa: BLE001
        return False


def wait_healthy(timeout_s=15.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if healthy():
            return True
        time.sleep(0.2)
    return False


server = None
if healthy():
    print(f"Using the space already running at {URL}")
    print(f"Open {URL} and watch the Feed tab.\n")
else:
    print(f"No space at {URL}; starting one...")
    port = URL.rsplit(":", 1)[-1]
    server = subprocess.Popen(
        ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env",
         "src/main.ts", "dev", "--port", port, "--storage", "sqlite", "--ext"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if not wait_healthy():
        print("server did not become healthy", file=sys.stderr)
        server.kill()
        raise SystemExit(1)
    print(f"Space up at {URL}. Open it and watch the Feed tab.\n")

client, ext = connect(URL)
require_ext(ext)

stop = threading.Event()
try:
    register_kinds(client)

    # Independent agents, no routing table; each self-selects by content.
    for target, args in [
        (planner_loop, (client, stop, print, PACE)),
        (worker_loop, (client, ext, "upper", stop, print, PACE)),
        (worker_loop, (client, ext, "reverse", stop, print, PACE)),
        (aggregator_loop, (client, stop, print)),
    ]:
        threading.Thread(target=target, args=args, daemon=True).start()

    wait_for_ops(ext, ["upper", "reverse"])
    summary = seed_and_await(client, ext, "the quick brown fox")

    print()
    print(f'RESULT: "{summary["body"]["text"]}"' if summary else "RESULT: (timed out)")

    events = client.get_events("0", 200)
    print(f"\nEVENT LOG ({len(events)} events), also visible in the Feed tab:")
    for e in events:
        print(f"  {str(e['seq']).rjust(2)} {e['operation'].ljust(8)} {(e.get('kind') or '').ljust(8)} {e.get('state') or ''}")
    if summary:
        lineage = client.get_lineage(summary["id"])
        depth = max(n["depth"] for n in lineage)
        print(f"\nLINEAGE of summary: {len(lineage)} records, {depth + 1} levels (summary -> results -> tasks -> job)")

    stop.set()
    time.sleep(0.3)
finally:
    stop.set()

if server and not ONCE:
    print(f"\nSpace still running at {URL}. Open it to explore, then press Ctrl-C to stop.")
    try:
        server.wait()
    except KeyboardInterrupt:
        server.kill()
elif server:
    server.kill()
    server.wait()
