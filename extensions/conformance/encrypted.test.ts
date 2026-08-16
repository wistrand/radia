// The fail-closed contract for encrypted bodies (`extensions/ts/encrypted.ts`).
//
//   deno task extensions
//
// One property: a reader that meets a marker it cannot handle RAISES, and nothing downstream ever
// sees the field. Nothing encrypts yet (plan-encryption.md phase 1 ships the refusal BEFORE the
// thing that needs it), so a planted `{enc: "v1"}` body is the whole fixture.
//
// The failure this stops is worse than a leak and quieter than a crash: ciphertext handed to a
// provider as text produces a confident answer about nothing, with nothing in the transcript
// saying why. So each reader is asserted at ITS OWN boundary rather than once at a shared helper —
// the helper is not what a future change routes around.
//
// The tool worker's half of the contract lives in tool-worker.test.ts, where the
// answer-not-a-nack rule it has to obey is already pinned.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { operatorToken } from "../../examples/operator.ts";
import { assembleContext, type ThreadRow, toMessage } from "../ts/context.ts";
import { assertReadable, encMarker, EncryptedBodyError, ENC_V1 } from "../ts/encrypted.ts";
import { contextForTest } from "../ts/inference.ts";

const PORT = 7841;
const url = `http://127.0.0.1:${PORT}`;

const row = (index: number, role: string, content: string, enc?: string): ThreadRow =>
  ({ index, role, content, ...(enc ? { enc } : {}) }) as ThreadRow;

async function withSpace<T>(fn: (c: RadiaClient) => Promise<T>): Promise<T> {
  const space = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "dev", "--port", String(PORT), "--artifact-port", "0"],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const probe = new RadiaClient(url);
  for (let i = 0; i < 100; i++) {
    try {
      await probe.health();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const c = new RadiaClient(url, { token: operatorToken(url) });
  await c.registerKind({
    kind: "message",
    indexedPaths: [
      { path: "conversationId", type: "keyword" },
      { path: "owner", type: "keyword" },
      { path: "index", type: "integer" },
      { path: "role", type: "keyword" },
    ],
    sortablePaths: ["index"],
    claimable: false,
  });
  try {
    return await fn(c);
  } finally {
    try {
      space.kill();
    } catch { /* already gone */ }
    await space.status;
    await new Promise((r) => setTimeout(r, 50));
  }
}

Deno.test("[encrypted] no marker this build can read, and that is the phase-1 contract", () => {
  assertEquals(encMarker({ content: "hello" }), undefined);
  assertEquals(encMarker({ content: "…", enc: ENC_V1 }), ENC_V1);
  // A non-string marker still refuses: the check is presence-of-something-unhandled, so a body
  // cannot slip past by carrying `enc: true`.
  assertEquals(encMarker({ enc: true }), "true");
  assertThrows(() => assertReadable({ enc: ENC_V1 }, "here"), EncryptedBodyError);
  assertThrows(() => assertReadable({ enc: "v99" }, "here"), EncryptedBodyError);
  assertReadable({ content: "plain" }, "here");
  assertReadable(undefined, "here");
});

Deno.test("[encrypted] the refusal names the READER, because that is the useful half", () => {
  const e = assertThrows(
    () => assertReadable({ enc: ENC_V1 }, "assembleContext"),
    EncryptedBodyError,
  ) as EncryptedBodyError;
  assertEquals(e.where, "assembleContext");
  assertEquals(e.marker, ENC_V1);
  assert(!e.message.includes("placeholder"), "never a substitute; the read stops");
});

Deno.test("[encrypted] the provider payload refuses an encrypted row, head or body", () => {
  const system = row(0, "system", "be brief");
  const plain = [row(1, "user", "hello"), row(2, "assistant", "hi")];
  assertEquals(assembleContext(system, plain).messages.length, 3, "a plaintext thread is untouched");

  assertThrows(
    () => assembleContext(system, [row(1, "user", "hello"), row(2, "assistant", "zzz", ENC_V1)]),
    EncryptedBodyError,
    "assembleContext",
  );
  // The head too. It is read directly rather than through `toMessage`, so a check placed only in
  // the converter would let the standing instructions through as ciphertext.
  assertThrows(
    () => assembleContext(row(0, "system", "zzz", ENC_V1), plain),
    EncryptedBodyError,
    "assembleContext",
  );
  // And the converter on its own, which `contextFor`'s unwindowed branch reaches directly.
  assertThrows(() => toMessage(row(1, "user", "zzz", ENC_V1)), EncryptedBodyError, "toMessage");
  assertEquals(toMessage(row(1, "user", "hello")).content, "hello");
});

Deno.test("[encrypted] the inference worker refuses at every way in", async () => {
  await withSpace(async (c) => {
    const conversationId = "conv-e";
    const owner = "human:alice";
    await c.put({ kind: "message", body: { conversationId, owner, index: 0, role: "system", content: "be brief" } });
    await c.put({ kind: "message", body: { conversationId, owner, index: 1, role: "user", content: "hello" } });

    // Control: the same call before anything is marked.
    const ok = await contextForTest(c, { conversationId, owner, upToIndex: 1 }, 40, 200_000);
    assertEquals(ok.messages.length, 2);

    // 1. A thread row. BOTH window settings, for the reason inference.test.ts asserts both: the two
    //    branches read the same records by different routes.
    await c.put({
      kind: "message",
      body: { conversationId, owner, index: 2, role: "assistant", content: "Y2lwaGVy", enc: ENC_V1 },
    });
    for (const window of [0, 40]) {
      const e = await contextForTest(c, { conversationId, owner, upToIndex: 2 }, window, 200_000)
        .then(() => null, (err) => err);
      assert(e instanceof EncryptedBodyError, `window=${window}: refused rather than rendered`);
    }

    // 2. The call body itself, which carries prose inline and beside a reference.
    const inline = await contextForTest(
      c,
      { messages: [{ role: "user", content: "zzz" }], enc: ENC_V1 } as never,
      40,
      200_000,
    ).then(() => null, (err) => err);
    assert(inline instanceof EncryptedBodyError, "an encrypted llm_call body is refused before its messages are used");

    // 3. The classify reference, whose text the worker fetches rather than receives.
    await c.put({
      kind: "message",
      body: { conversationId, owner, index: 9, role: "user", content: "Y2lwaGVy", enc: ENC_V1 },
    });
    const classify = await contextForTest(
      c,
      { system: "classify", classifyOf: { conversationId, owner, index: 9 } } as never,
      40,
      200_000,
    ).then(() => null, (err) => err);
    assert(classify instanceof EncryptedBodyError, "a reference resolving to an encrypted message is refused");
    assertEquals((classify as EncryptedBodyError).where, "contextFor(classifyOf)");
  });
});
