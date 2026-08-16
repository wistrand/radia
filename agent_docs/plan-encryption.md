# Encrypting chat content, opt-in per session

**Status: ALL PHASES BUILT (2026-08-16).** A conversation started with `--encrypt` seals its prose
end to end — messages, streamed chunks, tool arguments, tool output, a code runner's observations —
and destroying its key artifact erases it permanently while the records, their lineage and the event
chain survive. Read the accepted gaps at the bottom before treating this as confidentiality: the
fleet can read everything, and metadata is not protected.
Read
[design-data-model.md](design-data-model.md) (§2, artifacts and the erasure boundary) and
[plan-delegation.md](plan-delegation.md) (who holds which credential in a shared fleet) first.

## Why this is possible at all

**Nothing in the chat routes on prose, and that is structural rather than incidental.** No chat kind
declares an indexed path over text: `message` indexes `conversationId`/`owner`/`index`/`role`/
`callId`, `llm_call` indexes `tier`/`conversationId`/`owner`/`turnAt`, `tool_call` indexes
`tool`/`conversationId`/`owner`/`attempt`/`retryOf`/`turnAt` (`examples/chat/space/kinds.ts`).
`content`, `args`, `output` and `text` appear nowhere. A pattern naming an undeclared path is
refused when it compiles (`undeclared_path`), and patterns are data rather than code, so there is
no `$regex`, `$where` or `$expr` to search with even if a body field were indexed. The substrate
routes on identifiers and enums; the prose is payload it never inspects.

So the fields carrying prose can be ciphertext without the runtime noticing. Matching, watches,
lineage, flow mining, diagnostics, taint and the event chain all keep working: they use the clear
fields, or they hash whatever bytes they are given.

**Who reads the prose today**, which is what the key plan has to satisfy:

| reader | needs plaintext | why |
|---|---|---|
| inference workers | YES | they call the provider |
| the client | YES | it renders, and its payload assembly lives in `extensions/ts/context.ts` |
| tool workers | YES, for `args` | a tool runs on its arguments |
| the router | **no**, since phase 0 | it names the message instead of copying it, and holds no key |
| the turn worker | **no** | `TurnMessage` has no `content` field: the control flow runs on `role`, `index`, `tool_calls`, `i`/`of`/`round`/`turnAt` |

The turn worker needing nothing is the load-bearing fact. The component that performs a
conversation never sees what the conversation says.

## The unit is the CONVERSATION, even though the flag is per session

A session opts in with `--encrypt`; the choice is recorded at creation, as the presence of a
`conversation_key` record, and every later session INHERITS it. The flag is therefore needed only to
CREATE an encrypted thread: resuming one adopts its key whether or not the flag is passed, and the
banner says so, because a resumed session can be encrypted without anyone having asked in that
session.

The two directions are not symmetric, and only one of them refuses:

- **encrypted thread, no flag: adopt it.** Strictly more protection than was asked for, and the only
  thing that could work anyway: writing plaintext into it produces the half-encrypted thread that
  the mechanics below rule out.
- **plaintext thread, `--encrypt`: REFUSE.** Adopting the thread here would silently write in clear
  what someone explicitly asked to have encrypted, which is the one direction that turns a promise
  into a lie. There is no migration: the earlier turns cannot be re-sealed.

An UNVERIFIABLE resume refuses only in that second case: a key record that cannot be READ is not the
same answer as one that is absent, but refusing every such resume would break plaintext threads on
any space whose grants predate the `conversation_key` kind. Without the flag it continues in the
clear and says so; if the thread was encrypted after all, its rows carry the marker and the readers
refuse them, so the failure stays closed.

The reason is not policy but mechanics. A resumed session has to read what earlier ones wrote, and
`assembleContext` sends the WHOLE thread to the provider, so a half-encrypted thread is one the
model cannot be given. Per-session-per-record opt-in would produce exactly that.

## Ordering principle

By MODEL RISK (the plan-workspaces.md rule). The worst outcome here is not a leak, it is
**ciphertext reaching the model as if it were text**: the answer is confidently about nothing and
nothing in the transcript says why. The second worst is a write no later reader can decrypt, which
is data loss. So the refusal ships before the thing that needs it, and keys ship before the first
encrypted field.

## Phase 0: classify BY REFERENCE — BUILT 2026-08-16

`workers/router.ts` copies the user's text into a classify `llm_call` body and writes it as a
record carrying no `conversationId` and no `owner`. Three consequences, and only the third is about
encryption:

- It is user prose in an UNSCOPED record. Scoped sessions cannot read it, but only because a
  missing field does not match their grant pattern. That is an accident holding a boundary.
- It is a second prose site with no conversation to take a key from.
- The router would otherwise have to hold a decryption key.

Fix: pass the message ID and let the inference worker assemble the classify prompt from records it
is already reading. The router keeps its job (pick a tier, hold no API key) and stops handling
text at all.

### The rule this phase must land with, or it makes things worse

**A worker must never read a record named by a body field using its own authority.** Passing an id
instead of the text moves the READ from the writer to the worker, and the worker is unscoped.
Written naively, Alice writes `{owner: alice, classifyOf: <bob's message>}` — a body that matches
her own `llm_call: put` grant — and the worker fetches Bob's message and classifies it, stamping
the result for her. That is a confused deputy, deliberately introduced, in exchange for a scoping
accident.

Always dereference as the CALLER: a delegated run (plan-delegation.md), or the caller's scope
conjoined into the query. Never the worker's own grant on an id from a body.

**This was not hypothetical, and it was not new.** The same shape already existed in `contextFor`
(`extensions/ts/inference.ts`), where the `window <= 0` branch read
`{conversationId: body.conversationId}` with no owner while the windowed branch conjoined
`owner: body.owner`. Recorded as package V in
[plan-audit-remediation.md](plan-audit-remediation.md), REPRODUCED, then fixed before this phase
landed, so the rule existed in the code before a second caller depended on it.

**How it was built.** The reference is `(conversationId, owner, index)`, not a record id: all three
are declared indexed paths, so the reader resolves it with an ordinary pattern query under its own
`message` grant with the caller's scope conjoined. A raw id would need a get-by-id, which is the
ops plane, and would hand the worker a dereference no grant narrows.

The reference stays NESTED under `classifyOf`, so the classify record is still unscoped. Hoisting
`conversationId` to the top level would index it and read better, and it would break the path:
`conversationId === undefined` is how the reader tells a one-off call from a conversation call, so
a hoisted field would make the classifier ack an assistant `message` into the user's thread instead
of the `llm_result` the router polls for. What the change buys is that the unscoped record no longer
CONTAINS anything — it names a message, and only a reader already holding a `message` grant can
resolve it.

The router's own lookup (`currentTurn`) needed the same conjunction and did not have it. It is one
more instance of package V, in the worker that reads the text before anyone else does.

### Cost

Small and mostly favourable, and the interesting number is not the one this phase changes:

- **+1 indexed read per turn** in the inference worker. Against ~122 queries per turn (measured,
  `bench/suites/chatload.ts`) and an LLM round trip, under 1% and invisible in latency.
- **No extra read in the router.** It already queries the messages to count tool results; it stops
  USING `.content` rather than stopping reading.
- **One duplicate of every user message leaves the space.** The classify call embeds the full text
  and `router.ts` truncates nowhere, so a 100 KB paste is written twice, retained twice, and in the
  event log twice. By reference the worker can also cap what it sends the classifier, which the
  router cannot.
- **What actually costs reads here is the wait, not the text.** The router polls
  `readOne({kind: llm_result, match: {callId}})` every 100 ms for up to 60 iterations, on the path
  in front of EVERY turn, while the rest of the client uses watches. Sixty reads against this
  phase's one. If the goal is router performance rather than encryption surface, that loop is the
  change to make, and it is independent of everything here.

Guards: `extensions/conformance/inference.test.ts`, both proved red. A call naming another owner's
CONVERSATION gets an empty context at BOTH window settings (the package V regression, which fails
at `window=0` and passes at 40, which is why a guard covering only the default would have missed
it). A classify REFERENCE naming another owner's message resolves to nothing, while an honest one
returns system plus the referenced text.

## Phase 1: the marker and the FAIL-CLOSED contract — BUILT 2026-08-16

The clear marker `enc: "v1"` on a body, and every prose reader refusing a marker it cannot handle.
Nothing is encrypted yet, so this phase is pure refusal, proved with a hand-written record.

Always: a reader that sees a marker it cannot handle RAISES. Never: pass the field through, and
never substitute a placeholder into anything a model or a person will read — a placeholder is how
ciphertext becomes a plausible answer instead of an error.

`extensions/ts/encrypted.ts` holds the field name, the marker, `assertReadable(body, where)` and
`EncryptedBodyError`. The handled set is EMPTY and says so in place: phase 3 adds `ENC_V1` to it in
the same change that gives the readers a key, so there is no window where a marker is written and
silently tolerated. `where` names the READER, because the useful half of the report is which
component stopped.

The readers, each asserting at its own boundary rather than trusting a shared helper upstream:

| reader | site |
|---|---|
| the provider payload | `assembleContext` (whole batch, head included, before any structural work) |
| the row converter | `toMessage`, which `contextFor`'s unwindowed branch reaches directly |
| the call body | `contextFor`, which carries prose inline and beside a reference |
| the classify reference | `contextFor`, on the message it fetches rather than receives |
| tool workers | `serveTools`, on `args`, before dispatch |
| the chat client | `streamResult` (the assistant message and each `llm_chunk` delta) and `toolReply` |

**A tool worker ANSWERS rather than nacks.** The assert sits inside the handler's try, so the
refusal comes back as `ok: false` naming the reader. Raising to the loop would nack a record that
cannot become decryptable on redelivery, which is one poisoned queue entry replayed forever.

Guards: `extensions/conformance/encrypted.test.ts` plus one case in `tool-worker.test.ts`, all five
runtime sites proved red by removing the check. The two context sites OVERLAP, so each was proved
against the case only it covers: the system head (read directly, never through `toMessage`) and a
direct converter call.

**Gap:** the three chat-client sites are not covered by an automated guard. They are one-line calls
to the tested helper, and reaching them needs a running fleet plus a provider that stamps a marker
`finished()` does not write. Review, not a test, is what holds them.

## Phase 2: keys, DUAL-WRAPPED — BUILT 2026-08-16

Per-conversation DEK (AES-GCM-256), wrapped twice, because the shared-fleet split
(plan-scaling.md item 3) forces the second wrap:

- to the FLEET, because inference must decrypt to call a provider;
- under a PER-PERSON key held beside their credential (`src/credentials.ts`, already `0600`).

Fleet-only would mean every joining session needs the fleet's key to render its own messages, so
every person would hold the key to every conversation. Their grants still stop them FETCHING anyone
else's records, so it is not an immediate breach; it dissolves the safe-against-a-dump property for
anyone who has ever run a session.

`extensions/ts/encrypted.ts` holds the crypto and `KeyRing` (unwrapped DEK cached per conversation,
one unwrap per process, the promise cached so concurrent claims coalesce and a rejection evicts).
`examples/chat/space/keys.ts` holds the policy: which env var, which file, which record.

### Two things the plan got wrong, both found by building it

**The fleet half cannot be a symmetric KEK.** In join mode the SESSION creates the conversation —
there is no operator in that process — so whoever creates it must wrap the DEK for a fleet whose
secret they must not hold, and wrapping to a symmetric KEK IS holding it. So the fleet keeps an
RSA-OAEP key pair, publishes the PUBLIC half as an ordinary `fleet_key` record, and a session wraps
to it and can never unwrap. `fleetKeyId` (a digest of the public half, computed by both sides from
what they hold) makes a rotation report itself as a rotation instead of as a decrypt failure; the
two want different fixes and are otherwise indistinguishable. The person half stays symmetric,
because there the wrapper and the reader are the same party.

**Key material cannot live on the `conversation` record.** An anchor's only identifier is its record
id, and a session cannot fetch by id: get-by-id is the ops plane, and every public read is a pattern
over declared paths. A key only an operator can reach is no key. So the wraps live in a
`conversation_key` record addressed by `conversationId`, which a scoped grant binds exactly like
every other kind in this app.

### Who holds what

| key | held by | where |
|---|---|---|
| fleet private half | whoever runs `--serve` | `RADIA_CHAT_FLEET_KEY`, else `<RADIA_DIR>/chat-fleet-key.json`, 0600, generated at setup |
| fleet public half | everyone | the `fleet_key` registry, content-keyed so a restart republishes nothing |
| a person's key | that person | the credential file, under `#enckey:<principal>`, generated on first use |

The person key is kept OUT of the `#login` entry deliberately: a login is replaced wholesale on
every `radia login`, so a key stored inside it would be destroyed by re-authenticating, and the loss
is SILENT — the fleet wrap still opens everything, so nothing fails and the person half quietly
stops existing.

`--encrypt` is per session, the unit is the conversation, and a mismatch on resume is refused in
both directions rather than migrated. An unverifiable resume (the key record unreadable) also
refuses: `--encrypt` is a promise about where content goes, and a session that silently wrote a
plaintext thread would break it in the one way nobody checks.

Guards: `extensions/conformance/encrypted.test.ts` for the crypto (the four properties, plus the
fleet-rotation message and the KeyRing's eviction), and `examples/chat/smoke-encrypt.ts` for the
half a pure test cannot reach — whether the app's GRANTS let the right party fetch the key record.
Both halves have to hold: the wrap protects a dump, the grant protects a live space, and each looks
fine on its own while the other is broken. Proved red by planting a shared person key, a KeyRing
that remembers failures, a loose validator, and an unscoped `conversation_key` grant (under which
Bob reads Alice's entire key record).

## Phase 3: one field, end to end — BUILT 2026-08-16

`message.content`, and `llm_chunk.delta` beside it. A session encrypts, the inference worker
decrypts to call a provider, seals its answer and its stream, and the session opens both.

**The stream was not in this phase and had to be.** Encrypting the final answer while the same text
goes past in clear as chunks is a feature that looks like it works: chunks carry
`defaultRetentionSeconds: 24 * 3600`, so the whole conversation would sit on the space in the clear
for a day. `ENCRYPTED_FIELDS` names the fields per kind in one place, because a writer and a reader
that disagree produce a thread that renders half as ciphertext and nothing says so.

**Nonce = HKDF(DEK, idempotency key), for a KEYED write; random otherwise.** `Space.idem` hashes
`{kind, body, parentIds}` into `requestHash` to detect a different request under one key, so a
random nonce would make every keyed retry an `idempotency_conflict` — a substrate error for
something the substrate got right. A fully deterministic scheme leaks equality between identical
messages; deriving from the idempotency key does neither. An unkeyed write has no replay to match
and takes a random one. The nonce TRAVELS with the ciphertext (`base64(nonce || ct)`) rather than
being re-derived, or every reader would need the idempotency key the record was written under.

Never put an encrypted field in a CONTENT KEY. `procedure`, `workspace` and `capability` dedupe on
keys derived from body fields, and a value that varies per write turns a latest-wins registry into
an append-only one.

### Two things the build changed

**`READABLE` stays empty; DECRYPTING clears the marker.** Phase 1 said phase 3 would add `ENC_V1`
to the readable set once readers had keys. That turns the refusal off for every reader at once,
including one that forgot to decrypt — which would then pass ciphertext along in exactly the silence
the marker exists to prevent. Instead `openBody` strips `enc` from the copy it returns, so the
refusals downstream stop firing precisely where a key was applied and nowhere else. The plant
confirms it: with the worker's decrypt removed, it never reached the provider at all, because
`assembleContext` refused the rows.

**The router had to stop reading `.content`, and the classifier had to keep working.** Phase 0 moved
the user's text out of the classify record so the router would not need a key; it still read
`.content` to decide whether there was a question and to score `heuristicIndex`. On an encrypted row
that is base64, and its length is not the question's. It now yields no text for a marked row, which
is already the "unknown question" input that heuristic handles. Classification still happens, by
REFERENCE: the classify call is deliberately unscoped, so the inference worker resolves its key from
`classifyOf.conversationId` — with `classifyOf.owner`, so the lookup stays bounded by the caller.

**The DEK is never extractable.** The nonce needs HKDF over the DEK, and exporting raw bytes for it
would leave key material in a JS variable for the life of every worker. Unwrapping the same blob
twice — once as AES-GCM, once as HKDF — gives both handles and keeps `extractable: false`.

Guards: seven cases in `extensions/conformance/encrypted.test.ts` (round trip, the marker rule, the
nonce rule in both directions, the stream, an absent field, a wrong key and a flipped byte) and an
end-to-end turn in `examples/chat/smoke-encrypt.ts` through the REAL inference worker against a fake
provider that echoes its prompt — so "the worker decrypted" is asserted from what the provider saw,
not from what the reader returned. The stored rows are checked as the operator sees them. Proved red
by planting a random nonce, a marker that survives opening, a worker that skips the decrypt, and
unsealed chunks.

### Two wiring bugs no test could see, found by running the chat

Both were in the launcher, which every suite bypasses by constructing what it needs directly.

**The fleet key must be published before a conversation can be created.** A solo `deno task chat`
resolves its conversation and sets the space up AFTERWARDS, so a key published in `setUpSpace` did
not exist yet when `--encrypt` went to seal against it. It is published beside `registerChatKinds`
now, which is the last point before anything can write a conversation.

**The inference worker has no filesystem and must be HANDED the key.** `launchFleet` spawns it with
`--allow-net --allow-env` and nothing else, deliberately: it holds the API key. So its read of the
key file was a permission it does not have, and `fleetKeyPair` cannot tell "denied" from "absent" —
the worker simply served no encrypted conversation and said nothing. It now receives
`RADIA_CHAT_FLEET_KEY` from the launcher, which keeps its zero-filesystem property.

The suite missed the second because it spawned the worker under `-A`. It now spawns with exactly
the deployment's permissions and environment; a harness more privileged than the deployment cannot
see the deployment's failures. What is still uncovered is `launchFleet`'s own wiring: the suite
spawns its own worker, so removing that env would not fail anything.

### Not covered by phase 3

Tool messages: a slotted `tool_call`'s reply is a `message` written by a tool worker, which held no
key at this point. Closed by phase 4. Mixed threads read correctly regardless — `openBody` is a
no-op on an unmarked body — which is what makes a thread that predates a phase still readable.

## Phase 4: the remaining fields — BUILT 2026-08-16

`tool_call.args`, `tool_result.output`, `check.stdout` and `check.expected`, plus the tool
ARGUMENTS inside an assistant message (`llm_chunk` landed in phase 3). Routing and scope fields stay
clear, always: `bodyMatchesGrant` matches grant patterns against the BODY on write, and every
session scope is `{owner}` or `{conversationId}`, so encrypting either breaks authorization rather
than hiding anything. So do `verdict`, `callId`, `index` and a tool call's `id`/`name`.

`tool_call.args` is the one to think about rather than pattern-match. A tool acts on its arguments,
so a tool that writes a file or calls a network service moves that content OUT of the encrypted
set by doing its job. Encryption bounds what the SPACE holds, never what a tool does with what it
is given.

### The turn worker still holds no key, and that took a design

Sealing `tool_call.args` naively means the TURN WORKER encrypts them, since it is what turns an
assistant message into tool calls — and it reaches them through `parseArgs(call.function.arguments)`.
That would hand a key to the one component the design keeps blind: "the component that PERFORMS a
conversation never sees what the conversation says."

So the arguments are sealed ONE LEVEL DOWN, inside the assistant message, by the INFERENCE worker
that wrote it and already holds a key. A tool call's `id` and `function.name` stay clear because the
turn worker routes on them; only `function.arguments` is ciphertext. The turn worker then copies
that blob into `tool_call.args` verbatim, carries the marker across so the tool worker knows to open
it, and parses nothing. The parse happens on the far side of the key, in the tool worker.

One consequence worth knowing: an OPENED `tool_call.args` is the model's raw argument STRING, where
an unencrypted one is already an object. Both readers handle both shapes in one line.

The per-call index joins the idempotency key (`${key}#${i}`), or two calls in one round would derive
one nonce under one DEK — a guard caught exactly that when the index was left out.

### Who holds the fleet's private half now

Phase 2's accepted gap ("the fleet can read everything") gets a blast radius in this phase. It goes
to every worker that must read prose to do its job: inference (to call a provider), tools and images
(to act on arguments), exec (to run and judge code). The ROUTER and the TURN WORKER are deliberately
not on that list and must not be — they route an encrypted conversation without ever opening one.
It travels by ENVIRONMENT from the launcher, never read from disk, because each of those workers is
spawned with a deliberately narrow permission set.

### A third wiring bug, and the guard that now catches its class

Giving the exec worker a key broke it: the fleet spawns that one with `--allow-env=HOME`, and
`Deno.env.get` for a variable outside the list THROWS rather than returning undefined. The read runs
at module scope, so the worker died before advertising anything — five suite failures, none of them
mentioning the environment. Two fixes: the variable joins its allow-list, and every env read in
`space/keys.ts` goes through a helper that answers "unset" for a variable this process may not read,
so a narrow permission set degrades to having no key instead of failing to start.

`smoke-fleet.ts` already had the structural guard for this class, and its self-check ("this guard is
not silently testing nothing") caught that the new spawn argument had broken its parsing. It now also
checks WHICH variables a restricted worker reads, following its imports one level — skipping
`import type`, which is erased and whose reads never run. It sees LITERAL reads only, so the exec
worker's own indirected read stays invisible to it; that one is closed by the helper above, not here.

Guards: four cases in `extensions/conformance/encrypted.test.ts` (the JSON codec, arguments sealed
with routing intact, the per-call nonce, a check keeping its verdict clear), one in
`tool-worker.test.ts` (a sealed call opens for the tool and the answer is sealed under the same
key), and the FULL CHAIN in `examples/chat/smoke-encrypt.ts`: inference, turn and router workers
plus a tool worker, on an encrypted conversation, with a fake provider that reports what it was
shown. That last one is the only place the turn worker's blindness is observable, because a
worker-level test writes the `tool_call` itself. Proved red by planting a whole-array seal, a
missing per-call index, a turn worker that parses sealed arguments, and a tool worker that leaves
its reply in clear.

## Phase 5: erasure, and what the console shows — BUILT 2026-08-16

Destroying a conversation's key crypto-shreds its bodies, which is the only deletion path a record
body has. Same caveat as `shredArtifact`: it protects HIGH-ENTROPY content, and anyone holding a
candidate plaintext plus the ciphertext can still test a guess.

**The wraps had to move into an ARTIFACT, and phases 2-4 stored them in a record body.** That is the
erasure invariant restated: a body has no erasure path, which is precisely why erasable data belongs
in an artifact. Wraps stored inline could never be destroyed, so the conversation could never be
erased. The `conversation_key` record now NAMES the wraps (`{conversationId, owner, v, keys}`, where
`keys` is an artifact id) and the artifact holds them — the same shape, and the same reason, as an
OIDC profile artifact.

Erasing is then `radia shred <that artifact id>`, which already existed and needed nothing new. What
it costs at read time is one extra fetch per conversation per process, cached by the `KeyRing` after
the first.

**Both halves are asserted, and the second is the point.** After the shred: the person cannot open
the conversation, the FLEET cannot either (which is what makes it an erasure and not a permission
change), and both are told so by name — `ConversationErasedError`, matched on the space's `erased`
CODE rather than on the prose of a message. What SURVIVES: every record with its id and ordering,
the lineage walk, the event chain's verification (an erasure is not tampering), and the shred itself
on the ops plane, so `radia erasures` and `radia doctor` can report it.

**The console recognises the marker; it holds no key and never will.** The Records browser shows
`«encrypted»` in place of a body preview — sixty characters of base64 is noise that looks like data
— and the detail view says why, above the record as stored, whose routing fields are clear because
grants and matching read them. An `enc` badge joins the taint and delegation tags. The Feed needed
nothing: it renders event metadata, never bodies. Graph, flows, lineage and diagnostics keep working
throughout, because they mine structure.

## Rejected

- **Whole-body encryption.** `bodyMatchesGrant` matches grant patterns against the body on write,
  so an encrypted `owner` or `conversationId` fails authorization instead of protecting anything.
- **A key derived by HKDF from the conversation id, with nothing stored.** Zero plumbing, no extra
  read, no extra grant, and no way to destroy one conversation's key. Rejected for phase 5.
- **A symmetric fleet KEK, and key material on the `conversation` anchor.** Both were in this plan
  and both are wrong; see phase 2.
- **Refusing `--encrypt` in join mode**, which is what a symmetric fleet KEK would have forced. Join
  mode is the deployment shape the scaling work exists to produce, so a feature that skips it is a
  feature nobody deploys.
- **Random nonces**, and **fully deterministic encryption**. See phase 3: the first breaks
  idempotent retries, the second leaks equality.
- **Whitelisting the marker once readers hold keys.** Phase 1 planned it; see phase 3. It disarms
  the refusal for a reader that forgot to decrypt, which is the failure the marker is for.
- **Leaving `llm_chunk` to phase 4.** The plan put it there; a day of retained plaintext says
  otherwise.
- **Fleet KEK only.** See phase 2.
- **Indexing an encrypted field.** It would buy equality matching on ciphertext and nothing else,
  and search was never available: patterns are data.
- **Calling this end-to-end.** It is not, and saying so would be the most damaging line in the
  document.

## Accepted gaps

- **The fleet can read everything.** Inference decrypts by necessity. This protects against the
  store, a dump, the console, ops-plane readers and principals without the key. It does not protect
  against whoever runs the workers.
- **Metadata is not protected, and it says a lot.** Who talks to whom, when, how long a thread is,
  how many turns, which tools ran, how big each record is, and the full lineage graph all stay in
  the clear, because that is exactly what the substrate routes on. Anyone treating this as
  confidentiality against an observer of the space should read that list first.
- **No per-message opt-out** inside a thread, by construction (see the unit, above).
- **Debuggability drops.** The Feed stops being the place a bug is diagnosed for encrypted threads.
