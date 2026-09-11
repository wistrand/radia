"""A planner agent. It claims a `job`, splits its text into words, and emits one `upper` task
per word (fan-out), each linked to the job via parentIds. It acks the job with no result; the
emitted tasks carry the work forward.

EVERY FAN-OUT WRITE IS KEYED, and that is the whole correctness argument here. A handler that
returns its answer gets a keyed, fenced, parented ack for free, but a fan-out has N answers and
one ack, so these are ordinary puts that a redelivery writes twice: kill this process between the
puts and the ack and the job comes back, replays the whole fan-out, and the space holds two tasks
per word. Content-keying makes the replay a no-op.

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
            }, f"pipeline_task:{job['id']}:{i}")
            if pace:
                time.sleep(pace)
        log(f"[planner] job {job['id'][-6:]} -> {len(words)} tasks")

    agent_loop(client, "planner", [{"kind": "pipeline_job"}], handle, stop=stop, log=log)


if __name__ == "__main__":
    client, _ext = connect()
    print(f"planner connecting to {client.base}")
    planner_loop(client)
