// The credential file under CONCURRENT writers, which is what a laptop running several spaces is.
//
// The defect this pins: `writeEntry` was a plain read-modify-write, `read` answered `{}` for a
// half-written file, and a writer that read one put back a file holding its own entry and nothing
// else. It took a person's operator credential with it. Real processes, one file, every writer
// keeping its entry and everybody else's.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const WRITER = `
import { saveCredential } from "${new URL("../src/credentials.ts", import.meta.url).href}";
const base = Deno.args[0];
const r = saveCredential(base, { token: "t-" + base, mintedAt: new Date().toISOString() });
if (!r.ok) { console.error(r.error); Deno.exit(1); }
`;

Deno.test("credentials: twenty spaces writing at once lose nobody's entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-cred-race-" });
  const file = `${dir}/credentials.json`;
  const script = `${dir}/writer.ts`;
  await Deno.writeTextFile(script, WRITER);
  try {
    const bases = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${7000 + i}`);
    const runs = bases.map((base) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", new URL("../deno.json", import.meta.url).pathname, script, base],
        env: { RADIA_CREDENTIALS: file },
        stdout: "null",
        stderr: "piped",
      }).output()
    );
    const results = await Promise.all(runs);
    for (const r of results) assert(r.success, new TextDecoder().decode(r.stderr));
    const all = JSON.parse(await Deno.readTextFile(file)) as Record<string, { token: string }>;
    assertEquals(Object.keys(all).length, 20, `entries lost: ${Object.keys(all).length} of 20 survived`);
    for (const base of bases) assertEquals(all[base]?.token, "t-" + base);
    // The lock file is a sibling and stays; the temp files do not.
    const left = [];
    for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".tmp")) left.push(e.name);
    assertEquals(left, []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("credentials: a damaged file is refused, never replaced by one entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "radia-cred-corrupt-" });
  const file = `${dir}/credentials.json`;
  const script = `${dir}/writer.ts`;
  await Deno.writeTextFile(script, WRITER);
  try {
    await Deno.writeTextFile(file, '{"http://127.0.0.1:7788": {"token": "keep-me", "mintedAt": "x"}, "http://127.0.0.1:7');
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", new URL("../deno.json", import.meta.url).pathname, script, "http://127.0.0.1:9999"],
      env: { RADIA_CREDENTIALS: file },
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(!r.success, "a write over a damaged file must fail");
    assertStringIncludes(new TextDecoder().decode(r.stderr), "not valid JSON");
    assertStringIncludes(await Deno.readTextFile(file), "keep-me");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
