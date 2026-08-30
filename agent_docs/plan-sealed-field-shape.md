# Plan: a sealed field is a DIFFERENT field, so a naive reader fails loudly

**Status: PLANNED 2026-08-30.** Nothing built. Claims about current behaviour were verified against
source the same day. Prerequisite reading: [plan-encryption.md](plan-encryption.md), which this
does not revise; it changes one shape inside it.

## The problem, and why it is not the one the audits found

`sealBody` (`extensions/ts/encrypted.ts`) replaces a field IN PLACE and adds a marker:

```ts
const out: Record<string, unknown> = { ...body, [ENC_FIELD]: ENC_V1 };
out[f] = await encryptText(key, body[f] as string, idempotencyKey);
```

So a sealed `message` still has `content`, and `content` is base64. A reader that does
`provider.send(rec.body.content)` gets a plausible string and sends ciphertext to a model. Nothing
about that read is wrong-looking.

The fail-closed wall (`assertReadable`, `READABLE` permanently empty, the marker cleared only by
`openBody`) is correct and this plan does not touch it. Its reach is the limit: **a check in a
module only binds code that imports the module.** Every consumer in this repo asserts, and one
(`examples/chat/web/app.ts`) invented a different check instead, which is the in-repo version of
the same gap.

`extensions/` SHIPS IN THE NPM PACKAGE (`scripts/build-release.sh` stages `npm/radia/extensions`),
so third-party code can read a conversation from a space while importing none of this. For that
reader there is no type to violate, no assert to omit and no grep to fail. The only thing that
reaches them is the SHAPE OF THE RECORD.

## The change

Seal into a differently named field and DELETE the plaintext one, so `.content` on a sealed record
is `undefined`:

| kind          | today                              | proposed                                 |
|---------------|------------------------------------|------------------------------------------|
| `message`     | `content` = base64, `enc: "v1"`    | `contentSealed` = base64, no `content`   |
| `llm_chunk`   | `delta` = base64                   | `deltaSealed`, no `delta`                |
| `tool_call`   | `args` = base64                    | `argsSealed`, no `args`                  |
| `tool_result` | `output` = base64                  | `outputSealed`, no `output`              |
| `check`       | `stdout`, `expected` = base64      | `stdoutSealed`, `expectedSealed`         |

A naive reader then breaks at its first use of the value, with no import and no cooperation.
`openBody` restores the original name, so every reader that already decrypts is unchanged.

**The suffix is part of the contract, not a style choice.** `<field>Sealed` is derivable from the
field name, so `ENCRYPTED_FIELDS` stays the single declaration and no second table maps one to the
other.

## Why this is feasible, and the one property it rests on

**No sealed field is indexed.** Verified 2026-08-30 against `examples/chat/space/kinds.ts`:

| kind          | indexedPaths                                              | sealed              |
|---------------|-----------------------------------------------------------|---------------------|
| `message`     | `conversationId`, `owner`, `index`, `role`                | `content`           |
| `llm_chunk`   | `callId`, `index`, `conversationId`, `owner`              | `delta`             |
| `tool_call`   | `tool`, `conversationId`, `owner`, `attempt`, `retryOf`, `turnAt` | `args`      |
| `tool_result` | `callId`, `conversationId`, `owner`                       | `output`            |
| `check`       | `callId`, `conversationId`, `owner`, `verdict`            | `stdout`, `expected`|

Zero overlap, and that is structural rather than lucky: an undeclared path is refused at compile,
and plan-encryption.md turns on nothing routing on prose. So renaming a sealed field breaks no
pattern, no grant, no watch and no `order_by`. It is a body-shape change, never a routing one.

## What it costs, stated before someone finds it

- **Records already sealed carry the old shape.** `openBody` reads BOTH: the new field if present,
  else the old one. That branch is permanent, not a migration window, because records are immutable
  and a conversation sealed last month must still open.
- **Plaintext and sealed records stop being structurally identical.** That is a real loss and it is
  also the entire point: the difference is what the uninstructed reader trips over.
- **It does not protect a reader that passes a whole body onward.** A third party that forwards
  `rec.body` to something else is unaffected. The change targets the field-access path, which is
  the one that reads as ordinary code.
- **It is a breaking change for anyone storing sealed records today.** There is no second user
  ([research-positioning.md](research-positioning.md) still opens with that), which is the argument
  for doing it now rather than the argument for skipping it.

## Phases

1. **`sealBody` writes the new name and deletes the old.** `openBody` restores it, reading the new
   field first and falling back to the old. The nested case follows: a sealed tool call carries
   `function.argumentsSealed`, and the turn worker keeps routing on `id` and `function.name`, which
   it never could read anyway.
2. **The both-shape read is a conformance case, not a comment.** A hand-built old-shape record
   opens; a new-shape record opens; a record carrying BOTH is a refusal rather than a guess, since
   two ciphertexts for one field means somebody wrote a record two ways.
3. **A naive read fails loudly, asserted.** The case that states the whole point: seal a `message`,
   read `body.content` without decrypting, and assert it is `undefined` rather than a string. Prove
   it red against the current in-place shape first.
4. **The prose.** `plan-encryption.md` gains the shape and the reason; `extensions/README.md` gains
   the one sentence a third-party reader needs, since that file is what ships beside the code.

## What this does NOT replace

The fail-closed wall stays exactly as it is. This is a second, weaker mechanism aimed at a
population the first one cannot reach, and the two do not overlap: `assertReadable` protects
readers who import the convention, and the field name protects readers who do not. Neither is
sufficient and neither substitutes for the other.

Two smaller items from the same review, deliberately kept separate because they are independent:

- **`assertReadable` should reject a PRIMITIVE body.** `encMarker` returns `undefined` for a
  non-object, so `assertReadable(body.content, …)` passes silently, and reaching for the field you
  care about is the natural misuse. `undefined` and `null` must keep passing (a missing body is
  legitimate, asserted in `extensions/conformance/encrypted.test.ts`); a string or a number never
  is. Published API, so this is a shipped footgun rather than an internal one.
- **A grep guard over this repo's own readers**, in the shape of `test/registrycost.test.ts`: a
  module reading a body of an `ENCRYPTED_FIELDS` kind either asserts or appears in a named
  exemption list. Two entries on day one, both legitimate: the turn worker, which copies a sealed
  blob and must NOT assert, and `examples/chat/web/app.ts`, whose conversation-level gate is a
  second mechanism worth recording as one.

## Rejected

- **A branded `ReadableBody<T>` INSTEAD of this.** Worth building (a type is the only enforcement
  that crosses a package boundary, where a grep and a ledger do not), and it does not address this
  case: a third party who never imports `encrypted.ts` has no type to violate. Build it as well,
  after this; the ordering is on timing, since a wire shape gets harder to change every month it
  ships while a type can be added in any release.
- **Branding the STRING rather than the body.** It would bind the `provider.send(content)` path,
  and it collapses on the default: encryption is opt-in per session, so most conversations are
  plaintext, plaintext content is legitimately readable, and every plaintext path would need the
  escape hatch. A brand whose escape hatch is the common path trains people to reach for it.
- **Keeping the field and relying on `enc`.** That is today's design. The marker is discoverable
  and it is not self-announcing: it only helps a reader who already knows to look, which is the
  reader who was going to call `assertReadable` anyway.
