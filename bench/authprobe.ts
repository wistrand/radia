// Does authorization see the latest committed write, on every instance? Counted, not timed.
//
//   deno run -A bench/authprobe.ts --url http://127.0.0.1:7899
//   deno run -A bench/authprobe.ts --url http://a:7899,http://b:7899 --token <ta>,<tb> --rounds 100
//   deno run -A bench/cluster/run.ts authprobe --instances 3   # throwaway cluster + this probe
//
// Point it at N `radia serve` instances over ONE database. The rounds live in
// `bench/cluster/authrounds.ts` (what each count means is there); this is the CLI over them for a
// space that is already running. The rule against asynchronous read replicas (design-storage.md,
// "Scaling and multi-instance operation") is what the counts test for a deployment: zero on one
// instance says little, zero across several over one Postgres is the claim.
//
// Like `deployment.ts` it WRITES records it cannot take back: grants, runs and one definition per
// invocation. Use a throwaway space. Nothing asserts; the summary line is the answer.

import { RadiaClient } from "../sdk/ts/client.ts";
import { flag, has } from "../src/flags.ts";
import { resolveToken } from "../src/credentials.ts";
import { benchEnv } from "./env.ts";
import { AuthRounds } from "./cluster/authrounds.ts";

const argv = Deno.args;
const urlArg = flag(argv, "--url");
if (!urlArg || has(argv, "--help")) {
  console.log(
    "usage: deno run -A bench/authprobe.ts --url <base>[,<base>…] [--token <t>[,<t>…]] [--rounds n] [--window-ms n]\n\n" +
      "  Several URLs are several instances over one database, with one operator token per URL.\n" +
      "  Writes grants and runs it cannot delete: use a throwaway space. `bench/cluster/run.ts\n" +
      "  authprobe` starts N instances over a throwaway Postgres and runs the same rounds.",
  );
  Deno.exit(urlArg ? 0 : 2);
}
const urls = urlArg.split(",").map((u) => u.trim()).filter(Boolean);
// ONE OPERATOR TOKEN PER INSTANCE, in `--url` order: an operator token is held in the serving
// process's memory, never in a record, so instance A's is unknown to instance B. A single token
// is reused for every URL, which is right for one instance or for tokens a deployment shares.
const tokenArg = flag(argv, "--token") ?? Deno.env.get("RADIA_TOKEN");
const tokens = tokenArg ? tokenArg.split(",").map((t) => t.trim()) : urls.map((u) => resolveToken(u));
if (tokens.length !== 1 && tokens.length !== urls.length) {
  console.error(`--token has ${tokens.length} entries for ${urls.length} URLs: give one, or one per URL`);
  Deno.exit(2);
}
const rounds = Number(flag(argv, "--rounds") ?? 50);
const windowMs = Number(flag(argv, "--window-ms") ?? 300);

const admins = urls.map((u, i) => {
  const t = tokens.length === 1 ? tokens[0] : tokens[i];
  return new RadiaClient(u, t ? { token: t } : {});
});

for (const line of await benchEnv()) console.log(line);
for (const [i, a] of admins.entries()) {
  const h = await a.health();
  console.log(`${`inst ${i}:`.padEnd(9)}${urls[i]}  radia ${h.version}, storage ${h.storage}`);
}
console.log("");

const probe = await AuthRounds.create(admins, urls, { windowMs });
for (let r = 0; r < rounds; r++) {
  await probe.round(r);
  if ((r + 1) % 10 === 0) console.error(`  … ${r + 1}/${rounds} rounds`);
}
console.log(`${urls.length} instance(s), ${rounds} rounds, ${windowMs}ms window after each acknowledged write\n`);
console.log(probe.table());
console.log(`\n${probe.verdict()}`);
