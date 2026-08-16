# Encrypting chat content, opt-in per session

**Status: phases 0 and 1 BUILT (2026-08-16); 2-5 planned.** Nothing is encrypted yet: what exists
is the classify-by-reference change and the refusal every reader owes a marker it cannot handle.
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
| the client | YES | it renders, and assembles the provider payload (`client/context.ts`) |
| tool workers | YES, for `args` | a tool runs on its arguments |
| the router | yes, TODAY | it copies the text into a classify prompt (`workers/router.ts`) |
| the turn worker | **no** | `TurnMessage` has no `content` field: the control flow runs on `role`, `index`, `tool_calls`, `i`/`of`/`round`/`turnAt` |

The turn worker needing nothing is the load-bearing fact. The component that performs a
conversation never sees what the conversation says.

## The unit is the CONVERSATION, even though the flag is per session

A session opts in; the choice is recorded on the `conversation` record at creation and every later
session inherits it. Always immutable after creation: `--encrypt` against an existing plaintext
thread is REFUSED, never a migration.

The reason is not policy but mechanics. A resumed session has to read what earlier ones wrote, and
`client/context.ts` assembles the WHOLE thread for the provider, so a half-encrypted thread is one
the model cannot be given. Per-session-per-record opt-in would produce exactly that.

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

## Phase 2: keys, DUAL-WRAPPED

Per-conversation DEK, stored wrapped on the `conversation` record (which indexes nothing today, so
it gains a body field and no indexed path). This is the blob store's own shape lifted to bodies:
`BlobCipher` and `SealedKey` in `src/storage/crypto.ts`, a KEK loaded beside the database
(`loadKek`, `--blob-kek`).

**Wrapped twice**, and the second wrap is what the shared-fleet split (plan-scaling.md item 3)
forces:

- under the FLEET KEK, because inference must decrypt to call a provider;
- under a PER-PERSON key held beside their credential (`src/credentials.ts`, already `0600`).

Wrapping only under the fleet KEK would mean every joining session needs that KEK to render its own
messages, so every person would hold the key to every conversation. Their grants still stop them
FETCHING anyone else's records, so it is not an immediate breach, but it dissolves the
safe-against-a-dump property for anyone who has ever run a session.

Workers cache the unwrapped DEK per conversation; it never changes, so this is one read per
conversation per process.

Verify: a session decrypts its own conversation and cannot decrypt another person's even when
handed the record; the fleet decrypts both; a rotated person-key leaves the fleet wrap intact.

## Phase 3: one field, end to end

`message.content` only. The smallest thing that proves the whole loop: a session encrypts, the
inference worker decrypts and answers, the session renders, and a RETRY REPLAYS rather than
conflicting.

**Nonce = HKDF(DEK, idempotency key).** Deterministic per logical write, distinct across records.
This is the resolution of the one trap that would otherwise surface late and look like a substrate
bug: `Space.idem` hashes `{kind, body, parentIds}` into `requestHash` to detect a DIFFERENT request
under the same key, so a re-encrypted retry (the turn worker's keyed `turn:${id}` re-put) would hit
`idempotency_conflict` instead of replaying. A random nonce breaks retries; a fully deterministic
scheme leaks equality between identical messages; deriving the nonce from the idempotency key does
neither.

Never put an encrypted field in a CONTENT KEY. `procedure`, `workspace` and `capability` dedupe on
keys derived from body fields, and a value that varies per write turns a latest-wins registry into
an append-only one.

Verify: a full turn end to end with encryption on; the same turn with it off; a keyed re-put
produces byte-identical ciphertext and replays; the stored record contains no plaintext (asserted
against the row, not the API).

## Phase 4: the remaining fields

`llm_chunk.text`, `tool_call.args`, `tool_result.output`, `check.stdout`. Routing and scope fields
stay clear, always: `bodyMatchesGrant` matches grant patterns against the BODY on write, and every
session scope is `{owner}` or `{conversationId}`, so encrypting either breaks authorization rather
than hiding anything.

`tool_call.args` is the one to think about rather than pattern-match. A tool acts on its arguments,
so a tool that writes a file or calls a network service moves that content OUT of the encrypted
set by doing its job. Encryption bounds what the SPACE holds, never what a tool does with what it
is given.

## Phase 5: erasure, and what the console shows

Storing the wrapped DEK rather than deriving it is what makes this phase possible: destroying a
conversation's key crypto-shreds its bodies, which is the only deletion path a record body has
(the erasure invariant pushes erasable data into artifacts precisely because bodies have none).
Same caveat as `shredArtifact`: it protects HIGH-ENTROPY content, and anyone holding a candidate
plaintext plus the ciphertext can still test a guess.

The console's Feed and Records browser show `«encrypted»` for a body it cannot read. Graph, flows,
lineage and diagnostics keep working, because they mine structure.

## Rejected

- **Whole-body encryption.** `bodyMatchesGrant` matches grant patterns against the body on write,
  so an encrypted `owner` or `conversationId` fails authorization instead of protecting anything.
- **A key derived by HKDF from the conversation id, with nothing stored.** Zero plumbing, no extra
  read, no extra grant, and no way to destroy one conversation's key. Rejected for phase 5.
- **Random nonces**, and **fully deterministic encryption**. See phase 3: the first breaks
  idempotent retries, the second leaks equality.
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
