"""An aggregator agent (fan-in). Unlike workers, it READS results (facts) rather than claiming
them. When every result for a job has arrived it emits one `summary`, linked to all of them. The
idempotency key `summary:<jobId>` makes the emit safe when two aggregators race, PROVIDED they
share an identity: a key is scoped to the agent behind the caller, so two runs of one agent
dedupe and two different principals deliberately do not.

  python3 examples/pipeline-py/aggregator.py
"""
import threading

from common import connect


def aggregator_loop(client, stop=None, log=print):
    stop = stop or threading.Event()
    done = set()
    while not stop.is_set():
        by_job = {}
        for r in client.query_oldest({"kind": "pipeline_result"}, 500):
            job_id = r["body"].get("jobId")
            if job_id:  # standalone task results have no job
                by_job.setdefault(job_id, []).append(r)
        for job_id, rs in by_job.items():
            if job_id in done or len(rs) < rs[0]["body"]["total"]:
                continue
            ordered = sorted(rs, key=lambda r: r["body"]["index"])
            text = " ".join(str(r["body"]["output"]) for r in ordered)
            client.put(
                {"kind": "pipeline_summary", "body": {"jobId": job_id, "text": text}, "parentIds": [r["id"] for r in ordered]},
                f"summary:{job_id}",
            )
            done.add(job_id)
            log(f'[aggregator] job {job_id[-6:]} -> summary "{text}"')
        stop.wait(0.2)


if __name__ == "__main__":
    client, _ext = connect()
    print(f"aggregator connecting to {client.base}")
    aggregator_loop(client)
