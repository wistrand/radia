# Stress example — fill a space and watch the Space tab develop

A wave load generator: jobs fanned out into tasks, worker agents claiming by content, results and
facts piling up, plus deliberate chaos (poison records that retry into `dead_letter`, abandoned
leases left `leased`). Run it repeatedly — every run is a new wave with fresh agents.

```bash
deno task dev      # terminal 1 — open http://localhost:7788, Space tab
deno task stress   # terminal 2 — one wave
deno task stress -- --waves 3 --tasks 600 --rate 150 --workers 6
```

Fills a space with a **wave** of coordinated activity so the console's **Space** tab (the
property-similarity map) has something to develop. Each run is a new wave: a fresh wave tag,
**freshly minted agents** (so every run adds its own `run` clusters), a randomized op/topic mix,
and jittered volumes. Nothing is overwritten — re-run it and the map keeps growing.

Position in that view is a pure function of a record's **properties** — kind, envelope state,
owning run (`spaceNodeFor` in `src/ui/index.html`), never its links — so the generator varies all
three deliberately rather than only pushing volume:

- **kind** — `stress_job` (fanned out), `stress_task` (claimed by content), `stress_result`,
  `stress_fact` (never claimed: a pure `available` cluster), `stress_summary` (rolling fan-in).
- **run** — one agent per role plus **one per op**, each with its own run token, so the event log
  attributes every record to a distinct run. Workers hold a **template-scoped grant**
  (`take stress_task` narrowed to `{op, wave}`), so content routing is enforced by authorization,
  not just by the template a worker happens to send.
- **state** — acked work lands `consumed`; **poison** records are nacked repeatedly (attempt +1,
  back to `available`, reclaimed) until the runtime **dead-letters** them past `maxAttempts`; a
  chaos agent claims a few tasks under a 900s lease and walks away, leaving them **`leased`**
  after the run — a stuck-lease cluster for `space_doctor` and the remediation tools to find.

The retry churn is the most animated part: records flicker `leased → available` before settling.

| flag | default | effect |
|-------------|--------|------------------------------------------------|
| `--waves N` | 1 | waves per run, each with its own tag and agents |
| `--tasks N` | 240 | work items per wave (jittered ±25%) |
| `--facts N` | 120 | never-claimed records per wave |
| `--workers N` | 4 | worker agents, one op each (max 8) |
| `--rate N` | 60 | producer records/sec — pacing is what makes it animate |
| `--chaos PCT` | 12 | share of tasks that go poison or get abandoned |
| `--once` | off | tear down a spawned space at the end (CI) |

It prints per-wave counters and then the space's own totals by kind and state. The Space tab holds
3000 records (`SPACE_CAP`); past that it evicts finished ones (consumed, dead-lettered) in
least-recently-active order first, then live ones — so a heavy wave rolls off settled history
while work that is still moving stays on the map.

## Files

| File | Role |
|------|------|
| `stress.ts` | wave load generator (`deno task stress`): per-op worker agents, poison → `dead_letter`, abandoned leases → `leased`, for the Space tab |
