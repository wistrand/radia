# Running model-written code, in more than one language (design)

Why the language question is really an isolation question, how a space gains a language, and what
stops being true when it does. Nothing here is built beyond the JS runner that exists today
(`examples/chat/workers/exec.ts` dispatches; `extensions/ts/sandbox.ts` is the jail).

> **Status: design.** The SHAPE is decided: a sandbox is a record, matched by pattern like anything
> else. The isolation backends and the open questions at the end are not. Read [design-workspaces.md](design-workspaces.md) alongside this: a
> multi-file working tree and a second language interact, and the interaction is not small.

## Contents
- The actual constraint
- A sandbox is a RECORD, not a worker
- Isolation: the option space
- Proposed: one runner worker, many sandboxes
- What stops being uniform
- The directions nobody looked at
- Borrow the vocabulary that exists
- Where this collides with workspaces
- Settled by the arguments above
- Open questions

## The actual constraint

`run_code` looks like a JavaScript feature. It is not. **Deno's permission flags ARE the sandbox**:
the child gets `--no-prompt --no-remote --ext=js` and zero permissions, so no network, no writes, no
environment and no subprocesses is a property of how the process was started, not a convention the
program is asked to respect. Nothing in that mechanism generalises. Every other language needs a
different isolation story, and the language itself is the easy part.

So "support Python" is not a request for a Python parser. It is a request for a second security
mechanism, with a different blast radius, that a model cannot tell apart from the first.

## A sandbox is a RECORD, not a worker

The first draft of this document proposed one runner worker per language, each publishing a
`capability` with a `language` field. That is wrong, and the way it is wrong is instructive, so it
is recorded here rather than deleted.

**It conflates the language with the isolation.** `language: "python"` says nothing about what the
environment guarantees. Two Python runners with different jails collide on one capability name, and
an operator granting `tool_call{language:"python"}` has granted *any* Python runner, including the
weak one. The grant reads like a policy and is really a proxy for one.

**And it makes the guarantee prose.** The draft identified that the guarantee varies per runner and
then proposed to fix it by writing the isolation into the capability's DESCRIPTION: text the model
reads and the runtime cannot act on. That is a documentation fix for a substrate problem, and this
codebase has a name for the shape (a static table of runners, reachable only out of band; see
"express features through the substrate" in [CLAUDE.md](../CLAUDE.md)).

**A sandbox is an execution environment, which is a thing, so it is a record.**

```
kind: sandbox
body: { name, language, isolation, network, filesystem, writable, memoryMb, timeoutMsMax, version }
```

A registry like `model` and `capability`: latest-wins by name, withdrawn by a `retired: true`
successor, discovered by query. What changes by making it data rather than a worker's identity:

- **A grant scopes on the PROPERTY that matters, not on a proxy for it.** `tool_call{sandbox:
  "py-bwrap"}` pins a session to one environment; and because grant patterns match the body with
  dotted paths, a policy can bind what it actually cares about rather than a language name. This is
  the pattern-layer-as-authorization-primitive claim in
  [research-applications.md](research-applications.md) applied to execution.
- **The guarantee is matchable instead of readable.** "Which environments have no network" is a
  query. "Did this run somewhere with a filesystem" is a query. Neither is a sentence somebody has
  to keep true.
- **A `check` references a sandbox RECORD**, not a runner string, so an attestation carries the
  whole declared environment by reference. Open question 3 of the first draft dissolves.
- **Discovery is uniform.** The chat already learns its tools from `capability` records and its
  models from `model` records. Environments were the one thing it would have had to be told.

### Routing: the precedent already exists

`workers/router.ts` claims UNTIERED `llm_call`s (`{tier: {$exists: false}}`), classifies the turn,
and re-dispatches a tiered one that an inference-worker serves. Model selection is delegated to the
substrate rather than decided in the client.

Execution takes the same shape. A call arrives unassigned:

```
tool_call{ tool: "run_code", requires: {language: "python", network: false} }
```

A sandbox-router claims `{sandbox: {$exists: false}}`, reads the `sandbox` registry, picks one that
satisfies the requirements, and re-dispatches `tool_call{sandbox: "py-bwrap"}`. The runner claims by
plain equality on `sandbox`, which is all pattern matching needs to be.

That indirection is not ceremony. Patterns are equality and comparison, not subsumption: "an
environment that satisfies at least these requirements" is not expressible as a match, and pushing
it into the matcher would mean putting a solver in the routing language, which
[design-matching.md](design-matching.md) forbids for good reasons. A worker doing the selection is
where that logic belongs, and the chat already proves the shape works.

An agent may also skip the router and name a sandbox directly, having discovered one by query. Both
paths are ordinary content routing.

### Who writes the sandbox record

The open question this creates, and it matters more than the backend choice.

If a WORKER declares its own sandbox, the record is a manifest claim, and
[CLAUDE.md](../CLAUDE.md) is explicit that manifest claims are descriptive, never authorization: a
worker asserting `network: false` has asserted it. If an OPERATOR declares sandboxes and a worker is
granted the ones it may serve, the record inherits the grant model's property (assigned, never
self-declared) and an operator's policy binds to something they wrote.

The second is stronger and is the one to prefer. The operator knows what they installed; the worker
knows only what it believes. A middle path exists (worker declares, operator approves with a
successor) and is worth considering only if operator declaration proves too heavy in practice.

The tool contract is already language-neutral: source in, `{ok, stdout, stderr, exitCode, timedOut,
ms}` out, plus the optional `expect` that produces a `check`. Nothing in it mentions JavaScript.

## Isolation: the option space

Measured on this machine, since startup cost decides what a tight loop can afford. A model round is
1-10 SECONDS, so everything here is small by comparison; the numbers matter for how many attempts
fit in a turn, not for whether the substrate can keep up.

The table is measured the same way for every row (a shell loop, so each figure carries the same
process overhead) and is therefore like-for-like within itself. The in-process figure for the
existing runner, called through `runCode` as the worker calls it, is ~27 ms; that is the number
[design-workspaces.md](design-workspaces.md) quotes. Do not compare across the two.

| Mechanism | Languages | Isolation | Startup | Dependency | Portable |
|--------------------------|-----------------------|-------------------------------|-------------|--------------------------|-----------|
| **Deno flags** (built)   | JS/TS                 | deny-by-default, structural   | **35 ms**   | none (already required)  | yes       |
| Node `--permission`      | JS/TS                 | similar, much newer           | ~40 ms      | node (verified working)  | yes       |
| **bubblewrap**           | any                   | namespaces + seccomp          | **13 ms**   | `bwrap`                  | Linux only |
| container (docker)       | any                   | mature, well understood       | **~320 ms** warm, 3.6 s cold | daemon + images | mostly    |
| WASI (wasmtime)          | Rust/Go/C; Python via a wasm build | capability-based, no ambient authority | ~1-10 ms | runtime + a wasm build per language | yes |
| microVM (Firecracker)    | any                   | strongest                     | ~125 ms     | KVM                      | Linux only |
| remote service           | any                   | someone else's                | network     | a vendor                 | yes       |

Bubblewrap is **faster than the Deno runner already in use** (13 ms vs 35 ms), which removes the
usual reason to avoid an external jailer. A warm container is ~320 ms, roughly 10x Deno and 25x
bwrap: acceptable when a model round dominates, wasteful once a workspace loop runs many attempts.

### Latency is the wrong axis to choose on

Measured, and it changed the recommendation. To run `python3` under bubblewrap you must make the
interpreter visible, which in practice means binding the host's `/usr` read-only. What that jail can
then see:

```
bwrap --ro-bind /usr /usr …   4223 binaries in /usr/bin, 289 site-packages entries, all of /usr/share
docker python:slim-ish        142 binaries in /usr/bin (alpine, for scale)
deno, no --allow-read         nothing
```

Network was blocked in all three. The filesystem was not, and the difference is three orders of
magnitude against the option the timings favour.

So the fast path is **strictly weaker on filesystem than the Deno jail sitting beside it**, in the
same space, advertising through the same mechanism, to a model that cannot tell them apart. And this
is not a flag somebody forgot: it is INHERENT to how an interpreter is made available under bwrap.
The alternatives are to build a minimal rootfs per language, which is the work a container image
already did, or to accept the surface.

That inverts the naive reading of the table. A purpose-built image contains only what it needs, so
containers are STRONGER on filesystem isolation than bwrap-over-host-`/usr`, at 25x the latency. The
real trade is not speed versus portability; it is **latency versus filesystem surface**, and a
sandbox record has to state which one it bought.

**WASI is the philosophically correct answer and the wrong first move.** Capability-based with no
ambient authority is the same property that made Deno the right choice here, and it is the only
option in the table whose security model is *better* rather than merely equivalent. The cost is the
toolchain: a wasm build per language, and "run this Python script" means shipping a CPython wasm of
roughly ten megabytes. Right direction, later.

## Where this lands

`extensions/`, beside the workspace convention, not `src/` and not one application. A `sandbox`
record describes an execution environment: the runtime does not execute anything, so it has no
business knowing what a jail is, and an environment is meaningless inside a single app. Both halves
of the admission rule in [extensions/README.md](../extensions/README.md) are met, and the third
applies too — a runner's declared guarantees are attestable, so the probe that verifies them is a
contract other implementations must meet rather than one worker's private check.

## Proposed: one runner worker, many sandboxes

A single runner worker that serves whatever `sandbox` records it is granted, rather than one worker
written per language. Backends: `deno` (built in, no dependency), `bwrap` (Linux, the fast path),
`container` (portable fallback). Keep Deno the default so a checkout still runs JS with nothing
installed.

Adding a language is then declaring a sandbox and installing its interpreter, not writing or
deploying code. Which is the test this design has to pass: if adding Python needs a new worker, the
environments are still hiding in worker identity.

One caveat that the measurement below makes concrete: "installing its interpreter" is not free of
design. Where the interpreter lives decides what the jail can see, so the sandbox record must
describe the filesystem it actually got rather than the one intended.

## What stops being uniform

Adding environments is where a multi-language sandbox quietly becomes weaker than the one it
replaces, and it is worth being precise about which part the record shape fixes and which it does
not.

**The guarantee degrades from a property to a configuration.** "No network" under Deno is the
ABSENCE of `--allow-net`: structural, and hard to get wrong. Under a container it is
`--network=none`, a flag somebody can omit. Nothing about representing sandboxes as records changes
that. What changes is whether the degradation is VISIBLE.

- **Fixed by the record.** The environment's claims are body fields, so they are matchable,
  grantable, queryable and referenceable from a `check`. An operator asking "which of my sandboxes
  have a filesystem" gets an answer from the space rather than from a deployment script, and a
  policy binds to the property rather than to a language name that stands in for it.
- **NOT fixed by the record.** A sandbox record is a DESCRIPTION of a jail; the jail is what the
  launcher actually passes. A record saying `network: false` beside a launcher missing
  `--network=none` is a lie the runtime cannot detect, and it is a WORSE lie than the prose version
  precisely because structured data looks authoritative.

### Fail-closed by absence, fail-open by presence

The sharper statement of why this matters. Under Deno, "no network" is the ABSENCE of
`--allow-net`: forget everything and you get the safe answer. Under bwrap or a container it is the
PRESENCE of `--unshare-net` or `--network=none`: forget one and you get the unsafe answer, silently,
with the record still claiming otherwise.

That is not a degradation from "property" to "configuration". It is a flip from fail-closed to
fail-open, and it is the single most important thing this design changes about the sandbox.

**So the probe is not optional.** A runner VERIFIES each backend at boot: inside the jail it is about
to advertise, attempt a connection, attempt a write outside the workspace, list a path it should not
see. If a probe succeeds, refuse to publish that sandbox record. One probe per backend per boot,
cheap, and it converts every field of the record from a claim into a tested one. **This belongs in
v1**: a `sandbox` record nobody verifies is decoration, in exactly the way a `treeDigest` nobody
recomputes is (see [design-workspaces.md](design-workspaces.md)).

The general rule: **a claim a model reads is only as good as the enforcement behind it.** The
`run_code`/`save_content` overlap in [gotchas.md](gotchas.md) was the same failure in the tool
layer, where the fix could only be wording because nothing could enforce it. Here something can, so
wording is not the fix.

## The directions nobody looked at

The first draft worried about code escaping the jail. Three other paths carry model-influenced data
and none of them is inside one.

**Output flows back into places that interpret it.** stdout is untrusted bytes produced by
model-written code, and it lands in a `tool_result` record, in the model's next context, and in the
chat's TERMINAL. Terminal control sequences are the oldest trick in that list: a program that emits
escape codes can rewrite what the user believes it printed. Output is capped in size
(`maxOutputBytes`) and not sanitised. Whatever else varies per runner, the ANSWER path is shared, so
this is one fix for every backend.

**The launcher command is assembled from model input.** The Deno runner passes the program on stdin
and takes no arguments from the model, which is why it has no injection surface at all. A backend
that interpolates a language, an entrypoint or arguments into a command line has one. Build argv
arrays, never a shell string, and treat any runner that needs a shell as a runner that needs
justifying.

**Exhaustion has more dimensions than time and memory.** The Deno jail cannot spawn processes, so a
fork bomb is not expressible. Under bwrap and containers it is, and PID limits are separate flags
(`--unshare-pid` plus an rlimit) from the memory and timeout the current runner sets. A sandbox
record that says `memoryMb` and `timeoutMsMax` and nothing about process count describes a jail
weaker than the one it replaced.

## Borrow the vocabulary that exists

The `sandbox` body is a subset of what the OCI runtime spec already names: namespaces, mounts,
rlimits, seccomp profile, capability set, read-only paths. Inventing field names for those is how
two runners end up expressing the same jail differently, and how a policy written against one stops
meaning anything against the other.

Use OCI's names where OCI has one, and keep the record a SUBSET rather than a full spec: the record
is what a policy binds to and what a probe verifies, not a runtime configuration format. This is the
`.gitignore` lesson from [design-workspaces.md](design-workspaces.md) in another key. Thirty years
of container work has a vocabulary for isolation; a design that coins its own is choosing to
translate forever.

## Where this collides with workspaces

Single-file `run_code` takes source directly, which is why it needs no build concept. A multi-file
workspace needs an **entrypoint declaration**: how this project is run, which is per-language and
per-project. That is `{runner, entrypoint, args}` in the workspace manifest, and it is new design
rather than a field.

It also sharpens the dependency question in
[design-workspaces.md](design-workspaces.md). "Dependency-free" is plausible for JS and much less so
for Python, so a second language moves vendored-dependencies-as-artifacts from an option toward a
requirement. The upside stands: a vendored dependency set is part of the audited content, and
"exactly what was in scope when this ran" is a question no package manager answers.

## Settled by the arguments above

Three things were listed as open and are decided by sections of this document; leaving them open
would contradict the arguments that motivate them.

- **The OPERATOR writes `sandbox` records.** A manifest claim is descriptive by definition and an
  execution guarantee must not be. The operator configured the launcher; the worker only believes
  things about it.
- **A runner probes each backend at boot and refuses to advertise one that fails.** Required by
  "fail-closed by absence, fail-open by presence": without it the flip from safe-by-default to
  unsafe-by-default is undetectable, and the record makes it look verified.
- **The `sandbox` body uses OCI's vocabulary** where OCI has a name for the thing.

## Open questions

1. **Which backend, given that latency and filesystem surface trade against each other?** Not
   "bwrap or container" as a speed question. bwrap over the host `/usr` is fast and exposes three
   orders of magnitude more filesystem than the Deno jail beside it; a purpose-built image is small
   and 25x slower; a minimal rootfs per language is bwrap-fast with image-sized surface, and is the
   work an image already did. Supporting more than one doubles what the probes must cover.
2. **Conversation-scoped or owner-scoped grants on `tool_call{sandbox}`?** Same open question as
   workspaces, and it should get the same answer, since a workspace and the environment that runs it
   are two halves of one permission.
3. **Does the sandbox-router exist from the start, or does an agent name a sandbox directly?**
   Direct naming is less machinery and makes the agent choose an environment it may not understand.
   The router is the `llm_call` tier precedent and the same argument applies: selection is a decision
   to delegate, not one to encode in a client.
4. **How much environment does a `check` carry?** A reference to the sandbox record is the narrow
   version. The broad version pins the interpreter version and the dependency set too, which is what
   [research-applications.md](research-applications.md) §5 actually wants, and which only becomes
   answerable once workspaces vendor their dependencies.
5. **Is output sanitised, and where?** Terminal control sequences are the concrete case, and the
   answer-path is shared by every backend, so it is one fix rather than one per runner. Open only in
   WHERE: the runner strips, or the terminal renders defensively, or both.
