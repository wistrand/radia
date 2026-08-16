# Encrypting chat content, opt-in per session

**Status: PLANNED.** Nothing below is built. Read
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

## Phase 0: classify BY REFERENCE, worth doing regardless

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

Verify: the classify `llm_call` body carries no prose; the router's grants still work; tier
selection is unchanged for a fixed input (`smoke-*` router coverage).

## Phase 1: the marker and the FAIL-CLOSED contract, before any encryption

Add the clear marker `enc: "v1"` to the record body, and make every prose reader refuse a record
carrying a marker it cannot handle. Nothing is encrypted yet, so this phase is pure refusal and can
be proved with a hand-written record.

Always: a reader that sees `enc` and cannot decrypt raises. Never: pass the field through, and
never substitute a placeholder into anything a model will read.

The readers to cover: `client/context.ts` (the provider payload), `client/thread.ts` (rendering),
`extensions/ts/inference.ts` (the context window), and the tool workers for `args`.

Verify: a planted `{enc: "v1"}` record makes each reader raise, named per reader; a record without
the marker is untouched. Every guard proved red by removing the check.

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
