"""A worker agent. It claims ONLY tasks whose `op` matches the tool it runs: content routing,
no routing table. On top of the TS version it advertises the tool as a presence-policed
capability: while it beats, `tools` offers the op; kill the process and the offer ages out with
the beat, with nothing cleaning up after it.

  python3 examples/pipeline-py/worker.py upper
  python3 examples/pipeline-py/worker.py reverse
"""
import os
import sys
import threading
import time

from common import PRESENCE_KIND, PRESENCE_TTL_MS, TOOLS, agent_loop, connect, require_ext


def worker_loop(client, ext, op, stop=None, log=print, pace=0.0):
    if op not in TOOLS:
        raise SystemExit(f"unknown tool op: {op}")
    stop = stop or threading.Event()
    provider = f"worker:{op}"
    instance = f"{provider}:{os.getpid()}"

    ext.capability_declare()
    ext.presence_declare(PRESENCE_KIND, ttl_ms=PRESENCE_TTL_MS)
    # presence=True marks the advertisement as policed: a reader asking with this presence kind
    # withholds the tool unless a live beat backs it (extensions/ts/capability.ts).
    ext.publish_capability(
        {
            "type": "function",
            "function": {
                "name": op,
                "description": f"deterministic demo tool: {op}",
                "parameters": {"type": "object", "properties": {"input": {}}},
            },
        },
        provider=provider,
        presence=True,
    )

    def beats():
        while not stop.is_set():
            try:
                ext.beat(PRESENCE_KIND, provider, instance, ttl_ms=PRESENCE_TTL_MS)
            except Exception as e:  # noqa: BLE001. A missed beat is lateness, never a crash.
                log(f"[{provider}] beat failed: {e}")
            stop.wait(PRESENCE_TTL_MS / 1000 / 3)

    threading.Thread(target=beats, daemon=True).start()

    def handle(rec, _c):
        b = rec["body"]
        if pace:
            time.sleep(pace)
        # The result is a fact linked to its task (ack sets parent_ids = [task]).
        return {
            "kind": "pipeline_result",
            "body": {
                "op": op,
                "output": TOOLS[op](b.get("input")),
                "jobId": b.get("jobId"),
                "index": b.get("index"),
                "total": b.get("total"),
            },
        }

    try:
        agent_loop(client, provider, [{"kind": "pipeline_task", "match": {"op": op}}], handle, stop=stop, log=log)
    finally:
        # A clean shutdown withdraws now; a crash relies on the TTL, which is the point.
        try:
            ext.retire_presence(PRESENCE_KIND, provider, instance, ttl_ms=PRESENCE_TTL_MS)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    op = sys.argv[1] if len(sys.argv) > 1 else "upper"
    client, ext = connect()
    require_ext(ext)
    print(f"worker:{op} connecting to {client.base}")
    worker_loop(client, ext, op)
