# Running model-written code, in more than one language (design)

Why the language question is really an isolation question, how a space gains a language, and what
stops being true when it does. Nothing here is built beyond the JS runner that exists today
(`examples/chat/workers/exec.ts`, `examples/chat/tools/exec-sandbox.ts`).

> **Status: design.** The dispatch half is DECIDED, because it follows from architecture that is
> already built and needs no new mechanism. The isolation half is PROPOSED and carries the open
> questions at the end. Read [design-workspaces.md](design-workspaces.md) alongside this: a
> multi-file working tree and a second language interact, and the interaction is not small.

## Contents
- The actual constraint
- Dispatch: decided, and already free
- Isolation: the option space
- Proposed: a parameterised runner
- What stops being uniform
- Where this collides with workspaces
- Open questions

## The actual constraint

`run_code` looks like a JavaScript feature. It is not. **Deno's permission flags ARE the sandbox**:
the child gets `--no-prompt --no-remote --ext=js` and zero permissions, so no network, no writes, no
environment and no subprocesses is a property of how the process was started, not a convention the
program is asked to respect. Nothing in that mechanism generalises. Every other language needs a
different isolation story, and the language itself is the easy part.

So "support Python" is not a request for a Python parser. It is a request for a second security
mechanism, with a different blast radius, that a model cannot tell apart from the first.

## Dispatch: decided, and already free

A runner is a worker; a tool is a `capability` record; work is claimed by content. The exec worker
claims `tool_call{tool:"run_code"}`. A Python runner claims `tool_call{tool:"run_code",
language:"python"}` and publishes its own capability. Adding a language is adding a process.

Two things fall out with no design at all, and both are worth stating so nobody re-invents them:

- **Per-language grants.** A grant pattern is matched against the record body, so
  `tool_call{language:"python"}` is grantable and revocable independently of `{language:"js"}`. An
  operator allows one language and denies another without touching code, and the enforcement is the
  runtime's rather than the worker's.
- **Which languages a space can run is a QUERY**, over `capability` records (and `interest` records
  for what is listening right now). Not a deployment note somebody has to keep current.

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

Two results worth keeping. Bubblewrap is **faster than the Deno runner already in use** (13 ms vs
35 ms), which removes the usual reason to avoid an external jailer. And a warm container is ~320 ms,
roughly 10x Deno and 25x bwrap: acceptable when a model round dominates, wasteful once a workspace
loop runs many attempts.

**WASI is the philosophically correct answer and the wrong first move.** Capability-based with no
ambient authority is the same property that made Deno the right choice here, and it is the only
option in the table whose security model is *better* rather than merely equivalent. The cost is the
toolchain: a wasm build per language, and "run this Python script" means shipping a CPython wasm of
roughly ten megabytes. Right direction, later.

## Proposed: a parameterised runner

One worker, configured with runners, rather than one worker written per language:

```
--runner js:deno                    # built in, no dependency, the default
--runner python:bwrap:python3
--runner ruby:container:ruby:3.3
```

Each configured runner publishes its own `capability` record, so adding a language is operator
configuration in the same shape as `RADIA_CHAT_EXEC_DIRS` today, not a code change. Backends:
`deno` (built in), `bwrap` (Linux, the fast path), `container` (portable fallback). Keep Deno as the
zero-dependency default so a checkout still runs JS with nothing installed.

## What stops being uniform

This is the part that needs deciding rather than implementing, because it is where a multi-language
sandbox quietly becomes weaker than the one it replaces.

**The guarantee varies per runner, and nothing currently says so.** "No network" under Deno is the
ABSENCE of `--allow-net`: structural, and hard to get wrong. Under a container it is
`--network=none`, a flag somebody can omit. The strongest claim the sandbox makes degrades from a
property to a configuration, and that degradation must be visible rather than assumed.

Three consequences, all cheap if done up front and awkward afterwards:

- **A capability description states the isolation it got.** Descriptions are the documentation in
  this app: that is how `run_code` already tells a model there is no network. A runner that cannot
  honestly claim no-network must say so in its own description, or the model will carry the JS
  guarantees over to it. This is the same failure as the `run_code`/`save_content` overlap in
  [gotchas.md](gotchas.md): a model believes the description it reads, and an unstated limit is an
  assumed absence of one.
- **A `check` records WHICH RUNNER produced the verdict.** "This passed" is unqualified without
  "under what". `check` records exist now (see the chat README) and carry the expectation and the
  outcome; adding the runner identity is small, and without it an attestation from a weakly isolated
  runner is indistinguishable from one produced under zero permissions.
- **An operator can see what is installed and what it guarantees**, by querying `capability`, rather
  than by reading a deployment script.

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

## Open questions

1. **bubblewrap first, or container first?** bwrap is faster than what exists today and Linux-only;
   container is portable and ~25x slower. The principle in [CLAUDE.md](../CLAUDE.md) is maximal
   platform independence, which argues container; the measurements argue bwrap. Both, with the
   backend chosen per runner, is the obvious compromise and doubles the surface to test.
2. **Does a runner declare its guarantees, or assert them?** A description that SAYS no-network is a
   promise. A worker that verifies its own jail before advertising is an enforcement. The second is
   better and needs a way to test a backend at startup.
3. **Does `check` gain the runner, or does an attestation carry the whole environment?** The
   narrow version is one field. The broad version is a record of the runner, its version, its
   isolation flags and the dependency set, which is what the audit application in
   [research-applications.md](research-applications.md) §5 actually wants.
4. **Is `language` a field on `tool_call{tool:"run_code"}`, or a separate tool name per language?**
   One tool with a field keeps the model's list short and makes per-language grants a pattern.
   Separate names make each capability description self-contained, which matters more once the
   guarantees differ. Leaning toward the field, with the caveat in "what stops being uniform".
