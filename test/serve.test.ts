// `radia serve`: the posture a DEPLOYMENT runs in, as opposed to the one a laptop does.
//
// `dev` and `serve` share every line of machinery and differ only in what a start leaves lying
// around, so what is under test here is exactly that difference, and every case is a thing that was
// right on a laptop and wrong on somebody else's server:
//
//   - the operator token printed to stdout, which under a unit file IS the journal, and a token in
//     a log is a token in every backup of that log (CLAUDE.md's own rule)
//   - an operator credential written into the shared file the local CLI and MCP adapter read
//   - `--auth open`, which resolves a request carrying NO credential to the operator
//   - a space with nowhere to keep its data, reachable by omitting a flag
//   - the web console on a public route, which `GET /` is so the page can bootstrap
//
// SPAWNED, not called: the posture is what the process does, and half of these assertions are about
// its stdout and the files it touched. `deno test` needs `--allow-run=deno` for that (`deno.json`).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

/** Run `radia <args>` to completion and return what it said. For the refusals, which exit. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

/** Start a space, run `fn` against it, and stop it. Returns what the process said while it ran. */
async function serving<T>(
  args: string[],
  fn: (base: string) => Promise<T>,
): Promise<{ value: T; out: string; err: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "serve", ...args],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const port = Number(args[args.indexOf("--port") + 1]);
  const base = `http://127.0.0.1:${port}`;
  let value: T;
  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${base}/v0/health`)).ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    value = await fn(base);
  } finally {
    child.kill("SIGTERM");
  }
  const r = await child.output();
  return { value, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

const tmp = () => Deno.makeTempDirSync({ prefix: "radia-serve-" });

Deno.test("serve: refuses --auth open, because a request with no credential would be the operator", async () => {
  const r = await run(["serve", "--storage", "sqlite", "--db", `${tmp()}/s.db`, "--auth", "open"]);
  assertEquals(r.code, 2);
  assertStringIncludes(r.err, "does not accept --auth open");
});

Deno.test("serve: refuses to start with nowhere to keep its data", async () => {
  const r = await run(["serve", "--storage", "sqlite"]);
  assertEquals(r.code, 2);
  assertStringIncludes(r.err, "needs somewhere to keep its data");
});

Deno.test("serve: prints no token, writes no credential file, and serves no console", async () => {
  const dir = tmp();
  const creds = `${dir}/credentials.json`;
  const port = 7871;
  const before = await Deno.readTextFile(creds).catch(() => "");
  const r = await serving(["--storage", "sqlite", "--db", `${dir}/s.db`, "--port", String(port)], async (base) => {
    const root = await fetch(`${base}/`);
    const page = await root.text();
    // A coordination call with no credential. 401 is the whole posture in one number.
    const q = await fetch(`${base}/v0/records/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "task" }),
    });
    await q.body?.cancel();
    return { page, status: q.status };
  });
  assertEquals(r.value.status, 401, "an unauthenticated coordination call must be refused");
  assert(!r.value.page.includes("<html"), "the console must not be served unless asked for");
  assertStringIncludes(r.value.page, "--console");
  // NOTHING on stdout. Not "no token on stdout": nothing, because a service's stdout is the journal
  // and the credential lines are the only thing `dev` puts there.
  assertEquals(r.out.trim(), "", `serve wrote to stdout: ${r.out}`);
  assert(!r.err.includes("console sign-in"), "no sign-in link in the log either");
  assertEquals(await Deno.readTextFile(creds).catch(() => ""), before, "serve must not touch the shared credential file");
  assertStringIncludes(r.err, "no --operator-token-file");
});

Deno.test("serve: --operator-token-file is the only way to the operator bit, and it is owner-only", async () => {
  const dir = tmp();
  const tokenFile = `${dir}/op.token`;
  const r = await serving(
    ["--storage", "sqlite", "--db", `${dir}/s.db`, "--port", "7872", "--operator-token-file", tokenFile],
    async (base) => {
      const token = (await Deno.readTextFile(tokenFile)).trim();
      const res = await fetch(`${base}/v0/ops/stats`, { headers: { Authorization: `Bearer ${token}` } });
      await res.body?.cancel();
      return { status: res.status, mode: Deno.statSync(tokenFile).mode };
    },
  );
  assertEquals(r.value.status, 200, "the written token must actually be the operator");
  if (Deno.build.os !== "windows") {
    assertEquals(r.value.mode! & 0o077, 0, "the token file must not be readable by anyone else");
  }
  assertEquals(r.out.trim(), "", "still nothing on stdout");
});

Deno.test("serve: a config file is the same flag names, and a flag on the command line wins", async () => {
  const dir = tmp();
  await Deno.writeTextFile(`${dir}/radia.json`, JSON.stringify({ storage: "sqlite", db: `${dir}/s.db`, port: 7873, console: true }));
  // `--port` given twice over: once here and once in the file. `flag()` takes the FIRST occurrence
  // and the file is appended, so the command line wins, which is the way round an operator expects
  // when overriding one value to debug something.
  const r = await serving(["--config", `${dir}/radia.json`, "--port", "7874"], async (base) => {
    const page = await (await fetch(`${base}/`)).text();
    return page.includes("<html");
  });
  assert(r.value, "`console: true` in the file must serve the console");
  assertStringIncludes(r.err, "7874");
  assert(!r.err.includes("listening on http://127.0.0.1:7873"), "the file's port must have lost to the flag");
});

Deno.test("serve: a misspelled config key is refused by name, never ignored", async () => {
  // The misspelled-field class (plan-bounded-reads.md): a name the code picks up by spelling is
  // silently dropped when wrong, and a dropped setting reads as applied.
  const dir = tmp();
  await Deno.writeTextFile(`${dir}/bad.json`, JSON.stringify({ Port: 1 }));
  const r = await run(["serve", "--config", `${dir}/bad.json`]);
  assertEquals(r.code, 2);
  assertStringIncludes(r.err, "'Port' is not a flag name");
});
