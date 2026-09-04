// The S3 blob store against an endpoint that is NOT THERE. Every other S3 case needs a live
// endpoint (scripts/s3-conformance.sh); this one needs the opposite, and is what turns "SSO is
// broken" into "the S3 container is not running": a first sign-in writes a profile artifact, and a
// store that never answers must be a named 503, not an unhandled `TypeError: fetch failed`.
import { assertEquals, assertRejects } from "@std/assert";
import { RadiaError } from "../src/core/errors.ts";
import { S3BlobStore } from "../src/storage/s3.ts";
import { statusFor } from "../src/server/problem.ts";

/** A port the kernel just handed out and nothing listens on: a REAL refused connection, not
 *  Deno's own block on well-known ports, which throws before any socket is opened. */
function closedPort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

function unreachable(port: number): S3BlobStore {
  return new S3BlobStore({
    bucket: "nowhere",
    prefix: "",
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    pathStyle: true,
    accessKeyId: "k",
    secretAccessKey: "s",
  });
}

Deno.test("s3: an endpoint that never answers is blob_store_unavailable, naming the host", async () => {
  const port = closedPort();
  const err = await assertRejects(() => unreachable(port).put(new TextEncoder().encode("hello")), RadiaError);
  assertEquals(err.code, "blob_store_unavailable");
  assertEquals(err.message.includes(`127.0.0.1:${port}`), true, `the message names the host: ${err.message}`);
});

Deno.test("s3: reads and deletes fail the same way, never as a miss", async () => {
  // A `null` here would read as "no such blob" and an erasure would count as done.
  const store = unreachable(closedPort());
  const digest = "a".repeat(64);
  for (const op of [() => store.get(digest), () => store.delete(digest)]) {
    const err = await assertRejects(op, RadiaError);
    assertEquals(err.code, "blob_store_unavailable");
  }
});

Deno.test("s3: blob_store_unavailable is a 503 on the wire", () => {
  assertEquals(statusFor("blob_store_unavailable", 422), 503);
});
