"""The coordinator seeds work and reads outcomes, via the extension bindings where they say more
than a raw put: `tools` answers "who is ALIVE to do this" (capabilities policed by presence), and
`seed` writes the record and long-polls for a descendant of the answering kind, so there is no
hand-rolled poll loop here at all.

  python3 examples/pipeline-py/coordinator.py "hello there world"
"""
import sys
import time

from common import PRESENCE_KIND, PRESENCE_TTL_MS, RadiaExtError, connect, register_kinds, require_ext


def live_ops(ext):
    try:
        view = ext.tools(presence_kind=PRESENCE_KIND, ttl_ms=PRESENCE_TTL_MS)
    except RadiaExtError:
        return []  # a fresh space: no worker has declared the capability kind yet
    return sorted(row["tool"] for row in view.get("tools", []))


def wait_for_ops(ext, wanted, timeout_s=10.0):
    """A worker's first beat lands moments after it starts; give the fleet that moment."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        ops = live_ops(ext)
        if set(wanted) <= set(ops):
            return ops
        time.sleep(0.3)
    return live_ops(ext)


def seed_and_await(client, ext, text):
    register_kinds(client)

    ops = live_ops(ext)
    print(f"[coordinator] live tools: {', '.join(ops) or '(none: is a worker running?)'}")

    # A job to be planned + fanned out. Its summary lands three links downstream
    # (job -> tasks -> results -> summary), and seed-and-wait answers only a DIRECT child, so the
    # coordinator reads it by CONTENT instead: the summary carries the jobId it answers, which is
    # the same field the aggregator grouped the results by.
    seed_id = ext.seed("pipeline_job", {"text": text})["seedId"]
    summary = None
    deadline = time.time() + 20
    while time.time() < deadline and not summary:
        summary = client.read_one({"kind": "pipeline_summary", "match": {"jobId": seed_id}})
        if not summary:
            time.sleep(0.2)
    if summary:
        print(f'[coordinator] job summary: "{summary["body"]["text"]}"')
    else:
        print("[coordinator] no summary yet (are the planner/workers/aggregator running?)")

    # A standalone task that only worker:reverse matches. Its result IS a direct child (the
    # worker's ack names the task as parent), which is the shape seed-and-wait is for: one call
    # writes the record and long-polls the answer.
    r = ext.seed("pipeline_task", {"op": "reverse", "input": "radia"}, result_kind="pipeline_result", timeout_ms=10_000)
    reversed_ = r.get("result")
    if reversed_:
        print(f'[coordinator] standalone reverse -> "{reversed_["body"]["output"]}"')
    return summary


if __name__ == "__main__":
    client, ext = connect()
    require_ext(ext)
    seed_and_await(client, ext, " ".join(sys.argv[1:]) or "the quick brown fox")
