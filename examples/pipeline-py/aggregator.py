"""An aggregator agent (fan-in). Unlike workers, it READS results (facts) rather than claiming
them. When every result for a job has arrived it emits one `summary`, linked to all of them.

THE THREE READS ARE DELIBERATELY DIFFERENT (agent_docs/plan-bounded-reads.md). Candidates come
from a forward WALK that resumes where the last pass stopped, so every result is seen once and no
job is stranded by the window: this loop read the oldest 500 and then the newest 200, which strand
opposite halves of the space. The decision is an EXHAUST scoped to one `jobId` (an indexed path),
and "already summarized" is a NARROW read of one record. The TS twin runs the same three reads
under `reactorLoop`, which the Python SDK does not have yet, so this half stays a poll.

COMPLETENESS COUNTS DISTINCT INDEXES against an arity every part agrees on, not results against
whichever `total` arrived first. Counting read a replayed fan-out as complete (indexes [0,0,1] of a
three-word job summarized as "A A B"), and comparing against a missing `total` completed a job of
unknown length from one result.

The idempotency key `summary:<jobId>` makes the emit safe when two aggregators race, PROVIDED
they share an identity: a key is scoped to the agent behind the caller, so two runs of one agent
dedupe and two different principals deliberately do not.

  python3 examples/pipeline-py/aggregator.py
"""
import threading

from common import connect

# One page of the forward walk below. Not a ceiling on anything: the walk continues until a page
# comes back short, so this is how much arrives per round trip and nothing else.
PAGE = 200


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
    # HOW MANY THERE ARE IS THE JOB'S OWN CLAIM, and every result has to make the same one. A result
    # naming no `total` claims nothing, and in the TS twin `size < undefined` is false, so ONE of
    # them completed a job of unknown length; two results disagreeing is the same defect from the
    # other side. Refuse to decide, out loud, rather than deciding on nothing.
    totals = {r["body"].get("total") for r in results}
    total = next(iter(totals))
    if len(totals) != 1 or not isinstance(total, int) or isinstance(total, bool):
        log(f"[aggregator] job {job_id[-6:]}: {len(results)} result(s) claim totals {sorted(map(repr, totals))}; not deciding")
        return
    by_index = {}
    for r in results:
        by_index.setdefault(r["body"]["index"], r)
    if len(by_index) < total:
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
    # A memo, not the correctness argument: the key and the read above are. Seeded from the
    # summaries that already exist, in ONE read rather than a round trip per job.
    done = {s["body"]["jobId"] for s in client.query_all({"kind": "pipeline_summary"})}
    # HOW FAR THIS PROCESS HAS WALKED. Every result is seen exactly once, in order, and a job is
    # decided when the result that completes it arrives. NEITHER DIRECTION OF A FIXED PAGE WORKS
    # HERE, and both were shipped: the oldest N strands every job after the first N, the newest N
    # strands any job whose last result fell out of the window. `after`/`dir` is the resume
    # `query_page` documents for a watermark the caller keeps.
    after = None
    # Jobs a pass could not finish, carried: the watermark has already moved past the result that
    # named them, so dropping them on a transient failure is the same stranding by another route.
    pending = set()
    while not stop.is_set():
        jobs = pending
        pending = set()
        while True:
            records, _cursor, _scope = client.query_page({"kind": "pipeline_result"}, PAGE, after=after, dir="asc")
            for r in records:
                job_id = r["body"].get("jobId")  # standalone task results have none
                if job_id:
                    jobs.add(job_id)
                after = r["id"]
            if len(records) < PAGE:
                break
        for job_id in jobs:
            try:
                _summarize(client, job_id, done, log)
            except Exception as e:  # noqa: BLE001. Reported, and retried on the next pass.
                pending.add(job_id)
                log(f"[aggregator] job {job_id[-6:]}: {e}")
        stop.wait(0.2)


if __name__ == "__main__":
    client, _ext = connect()
    print(f"aggregator connecting to {client.base}")
    aggregator_loop(client)
