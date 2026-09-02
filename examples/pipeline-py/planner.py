"""A planner agent. It claims a `job`, splits its text into words, and emits one `upper` task
per word (fan-out), each linked to the job via parentIds. It acks the job with no result; the
emitted tasks carry the work forward.

  python3 examples/pipeline-py/planner.py
"""
import time

from common import agent_loop, connect


def planner_loop(client, stop=None, log=print, pace=0.0):
    def handle(job, c):
        words = str(job["body"].get("text", "")).split()
        for i, word in enumerate(words):
            c.put({
                "kind": "pipeline_task",
                "body": {"op": "upper", "input": word, "jobId": job["id"], "index": i, "total": len(words)},
                "parentIds": [job["id"]],
            })
            if pace:
                time.sleep(pace)
        log(f"[planner] job {job['id'][-6:]} -> {len(words)} tasks")

    agent_loop(client, "planner", [{"kind": "pipeline_job"}], handle, stop=stop, log=log)


if __name__ == "__main__":
    client, _ext = connect()
    print(f"planner connecting to {client.base}")
    planner_loop(client)
