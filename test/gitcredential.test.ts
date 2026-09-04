// `radia git-credential`: git's credential helper over the file `radia login` writes.
//
// Driven the way git drives it: `<helper> get` with `key=value` lines on stdin, `key=value` lines
// back on stdout. What is under test is the precedence (a login's durable half, else its run token,
// else the space's own credential) and the two quiet paths (`store`/`erase` do nothing; a protocol
// that is not HTTP is not answered, so git moves on to the next helper).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { baseKey, defaultBase } from "../src/credentials.ts";

async function helper(action: string, file: string, input = "protocol=http\nhost=127.0.0.1:7790\n\n"): Promise<{ code: number; out: string; err: string }> {
  // `action` may carry flags the way git's config line would: `get --host x` is three argv words.
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main.ts", "git-credential", ...action.split(" ")],
    env: { RADIA_CREDENTIALS: file, RADIA_TOKEN: "", RADIA_DEFINITION_TOKEN: "" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(input));
  await w.close();
  const r = await child.output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

Deno.test("git-credential: answers get with the login's durable half, else its run token", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-gitcred-" });
  const file = `${dir}/credentials.json`;
  const key = baseKey(defaultBase()) + "#login";
  try {
    await Deno.writeTextFile(file, JSON.stringify({ [key]: { principal: "human:alice", token: "run-abc", definitionToken: "def-xyz", mintedAt: "2026-09-04T00:00:00Z" } }));
    const durable = await helper("get", file);
    assertEquals(durable.code, 0, durable.err);
    // The username carries no colon: a Basic user-id may not, and a principal always does.
    assertEquals(durable.out, "username=human-alice\npassword=def-xyz\n");

    // An SSO login has no durable half, so the run token is what git gets.
    await Deno.writeTextFile(file, JSON.stringify({ [key]: { principal: "human:oidc-1", token: "run-sso", mintedAt: "2026-09-04T00:00:00Z" } }));
    const sso = await helper("get", file);
    assertEquals(sso.out, "username=human-oidc-1\npassword=run-sso\n");

    // No login: the credential the CLI's other verbs would use, which `radia dev` wrote.
    await Deno.writeTextFile(file, JSON.stringify({ [baseKey(defaultBase())]: { token: "op-token", mintedAt: "2026-09-04T00:00:00Z" } }));
    const op = await helper("get", file);
    assertEquals(op.out, "username=radia\npassword=op-token\n");

    // Nothing at all: a failure that names the fix, not a silent empty answer git would retry.
    await Deno.writeTextFile(file, "{}");
    const none = await helper("get", file);
    assertEquals(none.code, 1);
    assertStringIncludes(none.err, "radia login");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("git-credential: store and erase do nothing, and a non-HTTP ask is passed over", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-gitcred-" });
  const file = `${dir}/credentials.json`;
  try {
    await Deno.writeTextFile(file, JSON.stringify({ [baseKey(defaultBase()) + "#login"]: { principal: "human:alice", token: "run-abc", mintedAt: "2026-09-04T00:00:00Z" } }));
    for (const action of ["store", "erase"]) {
      const r = await helper(action, file, "protocol=http\nhost=x\nusername=u\npassword=p\n\n");
      assertEquals(r.code, 0);
      assertEquals(r.out, "", `${action} must print nothing`);
    }
    const ssh = await helper("get", file, "protocol=ssh\nhost=example.com\n\n");
    assertEquals(ssh.code, 0);
    assertEquals(ssh.out, "", "an ssh ask is somebody else's; answering it would hand a token to the wrong host");
    assert(!ssh.err.includes("radia login"));
    // The one that matters: a helper git may consult for ANY https host must not answer github.com
    // with a radia credential. Loopback only, unless a host is named.
    const github = await helper("get", file, "protocol=https\nhost=github.com\n\n");
    assertEquals(github.out, "", "a non-loopback host gets nothing");
    const named = await helper("get --host git.example.internal:7790", file, "protocol=https\nhost=git.example.internal:7790\n\n");
    assertStringIncludes(named.out, "password=run-abc", "a host named with --host is answered");
    const other = await helper("get --host git.example.internal:7790", file, "protocol=https\nhost=github.com\n\n");
    assertEquals(other.out, "", "…and naming one host does not open the others");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
