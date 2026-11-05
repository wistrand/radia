# Hash-Pinned Code Execution: specification (design)

**Status: PLANNED. Draft 1, 2026-10-22. Section 3 is the `t1` tree hash already computed by `extensions/ts/workspace.ts` (`treeDigestOf`); the rest is not implemented yet.**

This document specifies how a program and its files are named by hash, how a run of that program
is described, what the run may read and write, how its results are captured as a sequence of file
trees, and how the code talks to the runner. It is written to be implemented by any system. Apart
from the status line above, it names no product, and the encodings in section 3 are fixed so that
two conforming implementations compute identical hashes for identical content.

Read [notes/hash-pinned-execution.md](../notes/hash-pinned-execution.md) first: it is the model in
prose, for understanding rather than implementing. The rationale, the rejected alternatives and
how Radia maps onto this spec are in
[design-hash-pinned-execution-rationale.md](design-hash-pinned-execution-rationale.md). This
document states rules; those two explain them. Where they disagree, this document wins.
`test/treedigest.test.ts` computes every vector in Appendix A with `treeDigestOf` and checks the
doc still prints it.

## Contents

1. Conventions
2. Terms
3. Blobs and trees
4. Versions and refs
5. Sandbox profiles
6. Run specs
7. What a run sees
8. Capture: output steps
9. Run records and outcomes
10. The runner protocol
11. The process transport binding
12. Live log (reserved)
13. Conformance
14. Not covered
- Appendix A: test vectors
- Appendix B: relationship to git

## 1. Conventions

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

- **hex** means lowercase hexadecimal, two digits per byte.
- **SHA-256** is the hash in FIPS 180-4.
- **JCS** is the JSON Canonicalization Scheme, RFC 8785. Every hashed JSON value in this document is
  hashed as its JCS serialisation encoded as UTF-8, with no trailing newline.
- **UTF-16 order** compares two strings code unit by code unit as UTF-16, the shorter string first
  when one is a prefix of the other. It is the order JCS uses for object keys and the order section
  3.4 uses for tree entries. It differs from UTF-8 byte order for strings containing characters
  above U+FFFF (vector A.4).
- A field documented as **nullable** is always present; `null` means absent. An implementation MUST
  NOT omit a nullable field from a hashed object, since `{}` and `{"x": null}` hash differently.

## 2. Terms

| Term          | Meaning                                                                                  |
|---------------|------------------------------------------------------------------------------------------|
| blob          | A sequence of bytes, named by its blob digest                                            |
| tree          | A set of entries `(path, mode, blob digest)`, named by its tree hash                     |
| version       | A tree plus where it came from (parent version, origin). Not content-addressed           |
| ref           | A mutable name pointing at a version                                                     |
| profile       | A declaration of what a run may do and how far, named by its profile hash                |
| run spec      | Program tree, entrypoint, optional function, optional args tree, profile, determinism flag |
| attempt       | One execution of a run spec                                                              |
| step          | One captured output tree of an attempt                                                   |
| run record    | What the runner observed about one attempt                                               |
| runner        | The trusted process that materialises trees, starts the code and captures its output     |
| shim          | The per-language code inside the sandbox that implements the runner protocol for the program |

The **store** is wherever an implementation keeps blobs, trees, versions, refs and run records. Its
layout is implementation-defined.

## 3. Blobs and trees

### 3.1 Blob digest

A blob's digest is the hex SHA-256 of its bytes: exactly 64 characters, no prefix.

A store MUST verify that a blob's bytes hash to its digest when it stores the blob, and a reader
MUST verify it before relying on the bytes (section 7.2).

### 3.2 Tree entries

A tree entry is `(path, mode, digest)`.

- `digest` is a blob digest (3.1).
- `mode` is exactly `100644` (a regular file) or `100755` (an executable regular file). No other
  value is valid. Trees contain no directories, symbolic links, device nodes or permission bits
  beyond these two.
- A tree MUST NOT contain two entries with the same path.
- A tree MUST NOT contain a path that is a proper prefix of another path followed by `/` (a file
  `a` beside a file `a/b`), since no filesystem can materialise both.
- Directories exist only as path prefixes. An empty directory cannot be represented.
- A tree may be empty.

### 3.3 Paths

A path is a non-empty string of Unicode scalar values (no unpaired surrogates). It is compared
exactly: implementations MUST NOT apply Unicode normalisation or case folding when comparing,
sorting or hashing paths.

A valid path:

- is at most 512 UTF-16 code units long;
- does not start with `/`;
- contains no `\`, no NUL, and does not start with an ASCII letter followed by `:`;
- splits on `/` into segments that are all non-empty, none equal to `.` or `..`, none ending in
  `.` or a space;
- has no segment equal to `.git` under ASCII case folding.

A writer MUST refuse an invalid path rather than altering it. A writer SHOULD refuse a tree in which
two paths are equal under Unicode case folding or normalisation, since some filesystems store them
as one file; this is a SHOULD because existing trees may contain such pairs and their hashes must
stay valid.

### 3.4 Tree hash, algorithm `t1`

1. For each entry, form the line `path + U+0000 + mode + U+0000 + digest`.
2. Sort the lines in UTF-16 order (1).
3. Join them with U+000A. There is no trailing U+000A. The empty tree joins to the empty string.
4. Encode the result as UTF-8 and compute SHA-256.
5. The tree hash is the string `t1:` followed by the hex digest.

The `t1:` prefix names the algorithm. Any change to the input, separators, sort order or encoding
MUST use a new prefix, and a tag MUST NOT be reused. An implementation that meets an unknown prefix
MUST treat the hash as incomparable, never as a mismatch.

Because U+0000 sorts below every path character, sorting lines is the same as sorting entries by
path in UTF-16 order, with a path sorting before any longer path it is a prefix of (vector A.5).

### 3.5 What a tree hash does and does not cover

A tree hash covers the set of entries and nothing else. In particular it does not cover an
entrypoint, a name, a parent, a timestamp, or anything else describing the tree. Two trees with the
same entries have the same hash wherever and whenever they were made.

A tree hash is a claim until checked. Whoever relies on one (to run it, to attach a test result to
it, to reuse a result) MUST recompute it from the blobs, verifying each blob digest, or obtain it
from a component that did.

## 4. Versions and refs

### 4.1 Versions

A version records a tree together with how it came to exist:

| Field    | Type                  | Meaning                                                              |
|----------|-----------------------|----------------------------------------------------------------------|
| `id`     | string                | Unique within the store. Implementation-defined; not a content hash  |
| `tree`   | tree hash             | The files                                                            |
| `parent` | version id, nullable  | The version this one was derived from                                |
| `origin` | object                | Either `{"authored": <author id>}` or `{"run": <attempt id>, "step": <n>}` |

- A version MUST NOT alter its tree's hash; everything above except `tree` lives outside it.
- Versions are immutable once written.
- Two versions with the same `tree` hold the same files. An implementation SHOULD store each blob
  once regardless of how many versions reference it.

### 4.2 Refs

A ref maps a name to a version id.

- Updating a ref MUST be conditional on the version it currently points at (compare-and-set), so
  two writers that read the same version cannot both silently win.
- A new version written under a ref SHOULD name the ref's current version as its `parent`. Two
  versions naming the same parent are a fork. An implementation MUST make a fork visible (it MAY
  refuse the second update or record both); it MUST NOT discard either silently.
- Retiring a ref is a recorded state, not a deletion of its versions.

## 5. Sandbox profiles

A profile declares what a run may reach and how far it may go. It is a JSON object:

| Field                 | Type                    | Meaning                                                        |
|-----------------------|-------------------------|----------------------------------------------------------------|
| `network`             | boolean                 | Whether the run may open network connections                   |
| `channel`             | boolean                 | Whether the runner protocol (10) is available                  |
| `calls`               | array of strings        | Calls offered over the channel, in the order the runner lists them |
| `limits.timeMs`       | integer                 | Wall-clock limit for the attempt                               |
| `limits.outputBytes`  | integer                 | stdout plus stderr the runner stores                           |
| `limits.memoryBytes`  | integer, nullable       | Memory limit; `null` declares it unbounded                     |
| `limits.cpuMs`        | integer, nullable       | CPU-time limit; `null` declares it unbounded                   |
| `limits.captureFiles` | integer                 | Most files one step may contain                                |
| `limits.captureBytes` | integer                 | Most total bytes one step may contain                          |

Rules:

- The **profile hash** is `p1:` followed by the hex SHA-256 of the profile's JCS form. A run spec
  names a profile by its hash, never by a name, so the profile a run used cannot change after the
  fact. An implementation MAY keep names that resolve to profile hashes.
- A limit is either a number or an explicit `null`. A profile MUST NOT leave a limit implied.
- Whatever the profile says, a run MUST NOT receive environment variables from the runner, MUST NOT
  start other processes, and MUST NOT read any file outside what section 7 materialises.
  An implementation that needs to relax one of these MUST add a profile field for it, which
  changes the profile hash; it MUST NOT relax it silently.
- A runner MUST NOT accept a profile with an unknown field.
- **Checkable.** An implementation MUST provide a probe that runs a backend against a profile and
  fails if the backend allows anything the profile denies (at minimum: a network connection when
  `network` is false, reading a file outside the materialised trees, writing outside the working
  directory, starting a process). A backend that fails its probe MUST NOT run that profile.

## 6. Run specs

### 6.1 Fields

| Field           | Type                   | Meaning                                                          |
|-----------------|------------------------|------------------------------------------------------------------|
| `program`       | tree hash              | The program and every file it needs                              |
| `entrypoint`    | path                   | The file that starts. MUST be a path in `program`                |
| `function`      | string, nullable       | A function the entrypoint exports. Non-null makes this a call (6.3) |
| `args`          | tree hash, nullable    | The arguments tree                                               |
| `profile`       | profile hash           | The sandbox profile                                              |
| `deterministic` | boolean                | The author's claim that equal specs produce equal outputs (9.4)  |

The **spec id** is `s1:` followed by the hex SHA-256 of the run spec's JCS form, all six fields
present.

The entrypoint and function are outside the program's tree hash (3.5), so one program tree serves
any number of entrypoints and any number of argument sets without changing its hash.

### 6.2 Arguments

Arguments are files. The `args` tree is materialised read-only (7.1). A run with no arguments has
`args: null`.

A **serialised argument value** is an args tree containing exactly one entry, `args.json`, mode
`100644`, whose bytes are the JCS serialisation of the value. Equal values therefore produce equal
args trees and equal spec ids. A writer MUST produce `args.json` in JCS form; a runner MUST refuse a
serialised call (6.3) whose `args.json` is not byte-identical to the JCS form of its own parse.

### 6.3 Program runs and calls

- `function: null` is a **program run**: the shim starts the entrypoint as a program. There is no
  return value.
- `function: "<name>"` is a **call**: the shim loads the entrypoint, calls the named export with one
  argument, and captures the return value. The argument is the parsed `args.json` when `args` is a
  serialised argument value, the JSON value `null` when `args` is null, and otherwise the absolute
  path of the materialised args directory as a string.
- A call's return value MUST be JSON-serialisable. The runner writes its JCS form as `result.json`
  in the final step (8.3).

### 6.4 References to stored content

An argument may name stored content instead of carrying it. Inside `args.json`, a JSON object whose
only member is `"$tree"` with a tree hash value, or `"$blob"` with a blob digest value, is a
**reference**.

- The runner MUST find every reference in `args.json` before the run starts, materialise each one
  (7.1), and list them in the run record (9.2). A reference the runner cannot resolve fails the
  attempt with outcome `infrastructure` before the code starts.
- The code finds referenced content by hash at the location section 7.1 defines. `args.json` itself
  is never rewritten, so the spec id covers the referenced content transitively.
- An object of exactly that shape is always a reference. A value that needs to carry such an object
  literally must wrap it differently; this is a reserved form.
- References are found only in `args.json` of a serialised argument value, not in other args files.

## 7. What a run sees

### 7.1 Filesystem

Before the code starts, the runner builds the run's filesystem from stored blobs and nothing else:

| Location   | Contents                                              | Access     |
|------------|-------------------------------------------------------|------------|
| program    | The program tree                                      | read-only  |
| args       | The args tree, absent when `args` is null             | read-only  |
| refs       | Each reference (6.4) at `refs/<tree hash or digest>`, a tree as a directory and a blob as a file | read-only  |
| work       | Empty at start; the working directory                 | read-write |

- The absolute locations are implementation-defined. The shim MUST expose them to the code through
  its language API, and the process starts with `work` as its current directory.
- `work` MUST be the only writable location. The code MUST NOT be able to modify `program`, `args`
  or `refs`, including through a path that resolves into them.
- Each attempt runs in a fresh process. An implementation MUST NOT reuse a process between attempts.
- An implementation MAY cache a materialised tree by tree hash and share it read-only between
  attempts.

### 7.2 Verification

Every file the run can read MUST come from a blob whose digest the runner verified, in a tree whose
hash the runner recomputed (3.5), before the code starts. A mismatch fails the attempt with outcome
`infrastructure`; the code never runs on unverified content.

## 8. Capture: output steps

### 8.1 What is captured

Capturing reads the `work` directory and produces a tree:

- Regular files become entries. The mode is `100755` when the file is executable by its owner on a
  system with execute bits, otherwise `100644`.
- Symbolic links, directories (other than as path prefixes), and special files are not captured, and
  a capture MUST NOT follow a symbolic link. Each skipped path SHOULD be listed in the run record.
- A captured path that is invalid under 3.3 fails the capture with error `invalid_path` naming it.
- A capture exceeding `limits.captureFiles` or `limits.captureBytes` fails with error
  `capture_limit`. It MUST NOT store a truncated tree.
- The runner reads each file's bytes once, stores them, and uses the digest of the bytes it stored.

### 8.2 Steps

An attempt produces an ordered sequence of steps, numbered from 1.

- **Checkpoint.** The `checkpoint` call (10.5) captures `work` while the calling code waits for the
  response. If other threads of the program modify `work` during a capture, the captured tree is
  whatever the runner read; this specification defines no stronger consistency.
- **Final.** When the process exits, the runner captures `work` once more.
- **Unchanged adds nothing.** A capture whose tree hash equals the previous step's adds no step and
  reports the previous step. A final capture with no previous step and an empty tree adds no step,
  so an attempt that writes nothing has no steps.
- **Complete, not a diff.** Every step is a full tree. Unchanged files are the same blobs, so a step
  costs only what changed.
- Each step is written as a version (4.1) with `origin: {"run": <attempt id>, "step": <n>}` and
  `parent` set to the previous step's version, or `null` for step 1.
- A step is usable (inspectable, comparable, the program or args of another run) as soon as it is
  stored, including while the attempt is still running.

### 8.3 `result.json`

For a call (6.3), the final step contains `result.json` at the top level of the tree, holding the
JCS form of the return value, mode `100644`. If the code itself wrote `work/result.json` in a call,
the attempt fails with outcome `failed` and reason `result_conflict`. In a program run, `result.json`
has no special meaning.

### 8.4 Capture failures

- A failed checkpoint returns an error to the code, which may stop or continue. Earlier steps stay.
- A failed final capture makes the attempt's outcome `infrastructure` (9.3), whatever the exit status.
- Steps stored before a crash, timeout or kill stay stored and listed in the run record.

## 9. Run records and outcomes

### 9.1 Attempts

Every execution of a run spec is an attempt with its own id and its own run record. A retry is a new
attempt. Each attempt has its own step chain; steps with equal trees share blobs but are separate
versions.

### 9.2 The run record

Written by the runner, never by the code. It is not part of any tree hash.

| Field          | Content                                                                          |
|----------------|----------------------------------------------------------------------------------|
| `attempt`      | Attempt id                                                                       |
| `spec`         | Spec id, and the run spec itself                                                 |
| `number`       | 1 for the first attempt of this spec by this requester, incremented per retry    |
| `outcome`      | One of 9.3                                                                       |
| `reason`       | Nullable string: a machine-readable detail, such as `result_conflict` or `capture_limit` |
| `exitStatus`   | Nullable integer: the process exit status, when it exited                        |
| `started`, `ended` | Timestamps from the runner's clock                                           |
| `usage`        | Wall time, and CPU time and peak memory where the backend can measure them       |
| `environment`  | Interpreter name and version, sandbox backend and version, shim version          |
| `protocol`     | Nullable: the protocol version and the calls offered (10.3)                      |
| `inputs`       | Every reference (6.4) and every input call (10.4, 10.8), in order, each with the hash or identifier handed over |
| `effects`      | Every effect call (10.8), in order, with what the runner identified about each   |
| `steps`        | The versions of this attempt's steps, in order, each with its log position (12) when a log exists |
| `skipped`      | Paths not captured (8.1)                                                         |
| `log`          | Nullable: where the stored stdout and stderr are                                 |
| `reusedFrom`   | Nullable: the attempt whose result this record reuses (9.4)                      |

The run record MUST be written for every attempt that reaches the point of starting the code, and
SHOULD be written for one that fails before.

### 9.3 Outcomes

| Outcome          | Meaning                                                                   | Retry |
|------------------|---------------------------------------------------------------------------|-------|
| `succeeded`      | A program run exited with status 0, or a call returned                    | no    |
| `failed`         | Non-zero exit, a thrown error in a call, `result_conflict`, or a protocol violation | not automatically |
| `timeout`        | `limits.timeMs` was reached                                               | not automatically |
| `killed`         | Another limit was enforced                                                | not automatically |
| `infrastructure` | The runner could not do its part: unverifiable input, unresolvable reference, failed final capture, backend fault | MAY |
| `reused`         | Answered from a previous attempt (9.4) without running                    | no    |

- **A negative answer is a success.** A call that returns `{"ok": false}` has outcome `succeeded`.
  The runner MUST NOT interpret the content of a return value.
- `failed`, `timeout` and `killed` are about the code and its spec, so an equal retry is likely to
  repeat them. A runner MUST NOT retry them automatically unless the requester asked for it.
- `infrastructure` is about the runner, so a runner MAY retry it automatically.

### 9.4 Reuse

- A runner MAY answer a run spec from a previous attempt only when `deterministic` is true and that
  attempt's outcome was `succeeded`. The new run record has outcome `reused`, `reusedFrom` set, the
  previous attempt's steps, and no log.
- `deterministic` is the author's claim. A runner cannot check it and MUST NOT treat it as verified.
- The spec id does not cover the environment (9.2). A runner MAY additionally require equal
  `environment` before reusing, and SHOULD say in its documentation which it does.
- A runner MUST NOT reuse an attempt whose profile offers an effect call (10.8), whatever
  `deterministic` says: a reused run would skip effects the original performed.

## 10. The runner protocol

### 10.1 Layers

| Layer             | Defines                                               | Normative here |
|-------------------|-------------------------------------------------------|----------------|
| Language API      | How a shim exposes calls to the program               | No; each shim follows the call meanings below |
| Protocol          | Messages, ids, errors, versioning, call meanings      | Yes            |
| Transport binding | How messages travel in a given sandbox                | Section 11 for processes; other bindings MUST carry the same messages |

### 10.2 Messages

A message is a JSON object encoded as UTF-8.

- A message MUST NOT exceed 65,536 bytes. A runner MAY declare a larger cap in `hello`.
- **Request** (code to runner): `{"id": <integer>, "call": <string>, "args": <object>}`. `id` is a
  positive integer unique within the attempt.
- **Response** (runner to code): `{"id": <integer>, "result": <object>}` or
  `{"id": <integer>, "error": {"code": <string>, "message": <string>}}`. Exactly one per request.
- **Notification** (runner to code): `{"notify": <string>, "args": <object>}`. No response.
  Defined notifications: `cancel` (the requester asked the run to stop), `deadline` (args
  `{"remainingMs": <integer>}`). The code MAY ignore notifications; profile limits are the
  enforcement.
- Bytes never travel in messages. Data enters and leaves as files.

### 10.3 Handshake and versioning

- The runner's first message is `{"hello": {"protocol": 1, "calls": [...], "maxMessageBytes": <integer>}}`.
  The code MUST NOT send before it.
- `calls` is the profile's `calls`. The shim MUST expose only those; a call it does not list fails
  with `not_offered`.
- A shim that does not implement the offered protocol version MUST end the process before the
  program starts, which the runner records as `failed` with reason `protocol_version`.
- Evolution within a version is additive only: new calls and new optional fields. Anything else is a
  new protocol version, chosen by the profile.
- The runner MUST publish each protocol version's call list, with argument and result shapes, as
  data an author can read.

### 10.4 Call classes

Every call this specification defines belongs to exactly one class, and the class decides what the
runner records. Calls an implementation adds follow 10.8.

| Class       | Brings data into the run | Rule                                                             |
|-------------|--------------------------|------------------------------------------------------------------|
| Control     | No                       | No recording requirement beyond the log                          |
| Observation | No                       | Flows out to the log (12) only; never into a tree                |
| Input       | Yes                      | The runner MUST record the hash of what it handed over in `inputs` (9.2), and MUST hand data over as a path to materialised files, never as bytes |

Any call whose result carries data the code did not already have is an input call. A runner MUST
NOT offer an input call for which it cannot name exactly what it handed over.

### 10.5 Calls in protocol version 1

| Call          | Class       | Args                                     | Result                                       |
|---------------|-------------|------------------------------------------|----------------------------------------------|
| `checkpoint`  | Control     | `{"label": <string, optional>}`          | `{"step": <integer>, "tree": <tree hash>}` (8.2) |
| `deadline`    | Control     | `{}`                                     | `{"remainingMs": <integer>}`                 |
| `cancelled`   | Control     | `{}`                                     | `{"cancelled": <boolean>}`                   |
| `progress`    | Observation | `{"fraction": <number 0..1, optional>, "message": <string, optional>}` | `{}` |
| `event`       | Observation | `{"name": <string>, "fields": <object>}` | `{}`                                         |
| `materialize` | Input       | `{"ref": <tree hash or blob digest>}`    | `{"path": <string>}`                         |

`checkpoint` with an unchanged `work` returns the previous step's number and tree; with no previous
step and an empty `work` it returns `{"step": 0, "tree": <the empty tree hash>}`.

### 10.6 Errors

| Code               | When                                                         |
|--------------------|--------------------------------------------------------------|
| `not_offered`      | The call is not in `hello.calls`                             |
| `not_available`    | The profile has `channel: false` (returned by the shim)      |
| `invalid_args`     | Arguments do not match the call's shape                      |
| `message_too_large`| A message exceeded the cap                                   |
| `rate_limited`     | The runner's rate cap was exceeded                           |
| `invalid_path`     | Capture found an invalid path (8.1)                          |
| `capture_limit`    | Capture exceeded a profile limit (8.1)                       |
| `not_found`        | An input call named content the store does not hold          |
| `internal`         | The runner failed; the code may retry the call               |

The runner MUST also write every refused or failed call to the log, since an error visible only
inside the sandbox is invisible to whoever reads the run afterwards.

### 10.7 The channel is untrusted

The runner MUST validate every message, enforce the size cap and a rate cap, and apply every rule
on its own side. A malformed message, an unknown call, or a forged response id MUST NOT gain the
code anything; the runner either fails that call or ends the attempt as `failed` with reason
`protocol_violation`.

### 10.8 Extension calls

An implementation MAY offer calls this specification does not define, such as calls into a system
the runner is part of. It defines their meaning; this section bounds what they may do to the rest
of the model.

- An extension call's name MUST contain a `.` and SHOULD start with `x-` and an implementation
  name (`x-example.put`). Names without a `.` are reserved for this specification.
- An extension call is offered like any other: listed in the profile's `calls`, so it changes the
  profile hash, and in `hello.calls`.
- Every extension call MUST be declared as one of:
  - **control** or **observation**, under the rules of 10.4;
  - **input**, under the recording rule of 10.4: the runner records in `inputs` (9.2) an identifier
    that names exactly what it handed over and that cannot later name different content. An
    extension input MAY hand data over inside the response rather than as a path, within the
    message cap; it MUST then still be recorded;
  - **effect**: it changes state outside the run's trees. The runner MUST record every effect call,
    in order, in the run record's `effects` field, with what it identified about the effect.
- A profile that offers an effect call makes its runs non-reusable (9.4). Whether an effect is
  repeated, deduplicated or refused when an attempt is retried is the extension's responsibility,
  and its documentation MUST say which.
- The class of each extension call MUST be published with the call list (10.3).
- Effects are outside every tree: no tree hash, step or spec id covers them, in the same way that
  network access is not captured (14).

## 11. The process transport binding

For a sandbox in which the code is an operating-system process:

- Messages are framed one per line: the message's JSON with no unescaped U+000A, followed by U+000A.
- The channel is never stdout or stderr.
- The runner creates two pipes before starting the process. The process reads runner messages from
  file descriptor 3 and writes its messages to file descriptor 4. Where the process API cannot pass
  extra descriptors, the runner creates two named pipes in a private directory instead and passes
  their location to the shim through launch arguments.
- The runner opens both ends of both pipes before starting the process, so neither side blocks on an
  open.
- The runner stops reading when the process has exited and the pipe has been quiet for an
  implementation-defined window, since holding both ends means end-of-file may never arrive.
- With `channel: false`, the shim returns `not_available` for every call. It MUST NOT block or
  silently succeed.

## 12. Live log (reserved)

A conforming implementation in this draft MUST capture stdout and stderr up to
`limits.outputBytes`, store what it captured, link it from the run record, and record the log
position at each step. It SHOULD keep the beginning and the end of an oversized log rather than
only the beginning. The shim SHOULD disable output buffering so log positions are meaningful.

Streaming the log to viewers while the run is going (one sequence number across stdout, stderr and
runner events; resumable; stored as it streams; never back-pressuring the run) is reserved for a
later version of this specification.

The source of each log line is assigned by the runner from the pipe it read, never parsed from the
line, so code cannot print a line that passes as a runner event.

## 13. Conformance

An implementation claims conformance per layer. Each layer's suite MUST at least check the items
listed.

**Trees (3).**
- Every vector in Appendix A produces the stated hash.
- Each invalid path in 3.3 is refused.
- A blob whose bytes do not match its digest is refused.
- A file `a` beside `a/b` is refused.

**Runner (5 to 9).**
- The profile probe fails a backend that allows a network connection, a read outside the
  materialised trees, a write outside `work`, or a new process.
- The code cannot write to `program`, `args` or `refs`.
- A corrupted blob in the program tree fails the attempt as `infrastructure` without running code.
- An unchanged checkpoint adds no step.
- A capture over a limit fails without storing a truncated tree.
- A call returning `{"ok": false}` is `succeeded`; a call that throws is `failed`.
- A call that writes `work/result.json` fails with `result_conflict`.
- `failed` is not retried automatically.
- Every reference and every input call appears in `inputs` with its hash.

**Protocol (10, 11).**
- Messages survive heavy unterminated stdout output.
- A call not offered fails with `not_offered`.
- A message over the cap is refused.
- A forged response id or malformed message gains nothing.
- `channel: false` makes every call return `not_available` without blocking.
- Every extension call offered is declared with a class, every extension input appears in
  `inputs`, every effect appears in `effects`, and a profile offering an effect is never reused.

## 14. Not covered

- **Environment identity.** The interpreter and backend are recorded (9.2) but not part of the spec
  id, so equal specs on different interpreters share an identity.
- **Determinism.** The code may read a clock or a random source. Reuse rests on the author's claim.
- **Large dependency sets.** A vendored dependency tree is stored as ordinary entries, which makes
  large programs large trees. A dependency tree materialised beside the program, shared across
  programs, is an open question for a later version.
- **Outside effects.** Effect calls (10.8) are recorded but not captured or reproduced. With
  `network: true`, whatever the code does over the network is in no tree
  and may happen again on a retry.
- **Long-lived services.** A process serving many requests carries state between them, so no single
  request is explained by its recorded inputs.
- **Retention and erasure** of blobs, versions and run records are implementation policy.

## Appendix A: test vectors

Blob digests used below:

| Content           | Blob digest                                                        |
|-------------------|--------------------------------------------------------------------|
| empty             | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `hello\n`         | `5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03` |

**A.1 Empty tree.** No entries.
`t1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

**A.2 One file.** `hello.txt`, `100644`, content `hello\n`.
`t1:831c59c3a4b7e1b04227c08be837ca1d47ce4a13f35d2884d53fcfba94ff5857`

**A.3 Three files, one executable.**

| Path          | Mode     | Content          | Digest                                                             |
|---------------|----------|------------------|--------------------------------------------------------------------|
| `app/main.py` | `100644` | `print('hi')\n`  | `caf026f25d7140209f98072605307a438914b9ce6f3c14b23d15d9667241de52` |
| `README`      | `100644` | `x\n`            | `73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac` |
| `run.sh`      | `100755` | `#!/bin/sh\n`    | `a8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf` |

`t1:bcceaf773902b10f459c9db3eb99213f87c91c4addc17c36b1dc4a6e6db497a3`

**A.4 Sort order above U+FFFF.** Two files, both `100644`: path U+FF5E (content `a`) and path
U+1F600 (content `b`). In UTF-16 order U+1F600 sorts first (its leading code unit is 0xD83D); in
UTF-8 byte order it sorts second.
Correct: `t1:30d7f394913443de80e0b2d8f2510787713b5a3e78787ee9ad258e5292f272d8`
Byte-sorted (wrong): `t1:af1c71241ff5f71394bd16820873e7f9fcbde9d00f50971e3aec39a251d2d46a`

**A.5 Prefixes and separators.** Files `a/b.txt` (content `1`), `a.txt` (`2`), `a-b.txt` (`3`), all
`100644`. Sorted: `a-b.txt`, `a.txt`, `a/b.txt`.
`t1:28923b69777876f5631cdfbbaa031a7d6def7c7fb5f39cc16a18bfd72a71c4e3`

**A.6 Profile.**

```json
{"calls":["checkpoint","progress","event","deadline","cancelled"],"channel":true,"limits":{"captureBytes":33554432,"captureFiles":2000,"cpuMs":null,"memoryBytes":134217728,"outputBytes":65536,"timeMs":5000},"network":false}
```

`p1:67cb4cfa80b6186c2f7ef82a223d44849d7f3c5cacb945f0f24a6c81bcbfa302`

**A.7 Run spec.** Program A.3, entrypoint `app/main.py`, program run, no args, profile A.6:

```json
{"args":null,"deterministic":false,"entrypoint":"app/main.py","function":null,"profile":"p1:67cb4cfa80b6186c2f7ef82a223d44849d7f3c5cacb945f0f24a6c81bcbfa302","program":"t1:bcceaf773902b10f459c9db3eb99213f87c91c4addc17c36b1dc4a6e6db497a3"}
```

`s1:8e9ad186a86fe7067bbc9a47e4b3207ab2fce6759a8c89a3ae0107c25ff56654`

**A.8 Serialised arguments.** The value `{"text": "hi", "n": 3}` serialises to
`{"n":3,"text":"hi"}`; as the single entry `args.json`, `100644`, the args tree is
`t1:69daa0f24c349ea3422ee3ad6482bb3ceb49cc3f241c10286b7fc2f8a22a772e`

## Appendix B: relationship to git

Blobs, trees, versions and refs correspond to git's blobs, trees, commits and refs, and a tree can be
exported as a git tree. The hashes are different: git hashes a typed, length-prefixed object
encoding (SHA-1 or SHA-256), and a git tree nests one object per directory. A `t1` hash is
therefore never equal to a git tree id, and converting between them requires the blobs. Git is an
export format here, not the identity.
