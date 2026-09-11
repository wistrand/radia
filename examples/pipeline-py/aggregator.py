"""An aggregator agent (fan-in). Unlike workers, it READS results (facts) rather than claiming
them. When every result for a job has arrived it emits one `summary`, linked to all of them.

THE THREE READS ARE DELIBERATELY DIFFERENT (agent_docs/plan-bounded-reads.md). Candidates come
from a PAGE of the NEWEST results, which is a walk and never a completeness test: this loop read
the OLDEST 500 for both, so past 500 results the window pinned to the first jobs and no later one
ever finished. The decision is an EXHAUST scoped to one `jobId` (an indexed path), and "already
summarized" is a NARROW read of one record. The TS twin runs the same three reads under
`reactorLoop`, which the Python SDK does not have yet, so this half stays a poll.

COMPLETENESS COUNTS DISTINCT INDEXES, not results. Counting read a replayed fan-out as complete:
indexes [0,0,1] of a three-word job summarized as "A A B", word 2 missing.

The idempotency key `summary:<jobId>` makes the emit safe when two aggregators race, PROVIDED
they share an identity: a key is scoped to the agent behind the caller, so two runs of one agent
dedupe and two different principals deliberately do not.

  python3 examples/pipeline-py/aggregator.py
"""
import threading

from common import connect

# How many of the newest results a pass looks at to find jobs worth checking. Bounded ON PURPOSE:
# a job completes while its results are still among the newest, and each candidate is then re-read
# exhaustively before anything is decided.
CANDIDATES = 200


def _summarize(client, job_id, done, log):
    if job_id in done:
        return
    # NARROW: one current thing. Survives a restart past the idempotency window, where the key no
    # longer dedupes and this is the only thing standing between a replay and a second summary.
    if client.read_one({"kind": "pipeline_summary", "match": {"jobId": job_id}}):
        done.add(job_id)
        return
    results = client.query_all({"kind": "pipeline_result", "match": {"jobId": job_id}})
    if not results:
        return
    by_index = {}
    for r in results:
        by_index.setdefault(r["body"]["index"], r)
    if len(by_index) < results[0]["body"]["total"]:
        return
    ordered = [by_index[i] for i in sorted(by_index)]
    text = " ".join(str(r["body"]["output"]) for r in ordered)
    client.put(
        {"kind": "pipeline_summary", "body": {"jobId": job_id, "text": text}, "parentIds": [r["id"] for r in ordered]},
        f"summary:{job_id}",
    )
    done.add(job_id)
    log(f'[aggregator] job {job_id[-6:]} -> summary "{text}"')


def aggregator_loop(client, stop=None, log=print):
    stop = stop or threading.Event()
    done = set()  # a memo, not the correctness argument: the key and the read above are
    while not stop.is_set():
        jobs = []
        for r in client.query_newest({"kind": "pipeline_result"}, CANDIDATES):
            job_id = r["body"].get("jobId")  # standalone task results have none
            if job_id and job_id not in jobs:
                jobs.append(job_id)
        for job_id in jobs:
            _summarize(client, job_id, done, log)
        stop.wait(0.2)


if __name__ == "__main__":
    client, _ext = connect()
    print(f"aggregator connecting to {client.base}")
    aggregator_loop(client)
