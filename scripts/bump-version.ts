// Set every version string for a release, and print the git commands that ship it.
//
// The scheme is CalVer as semver, `YYYY.M.COUNTER` (src/version.ts): month unpadded because
// semver refuses a leading zero, counter restarting at 0 each month. Three files carry the
// string and must agree (test/tasks.test.ts guards the first two):
//
//   deno.json        what build-release.sh stamps onto every package
//   src/version.ts   what the compiled binary reports
//   docs/install.sh  the RADIA_VERSION example in the installer header
//
//   deno task bump              # next version for the current month (UTC clock)
//   deno task bump 2026.9.3     # set exactly this version instead
//
// Writes the files and PRINTS the git commands; it runs none of them.

const file = (p: string) => new URL(`../${p}`, import.meta.url);
const current = (JSON.parse(await Deno.readTextFile(file("deno.json"))) as { version: string })
  .version;

const CALVER = /^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;

const override = Deno.args[0];
let next: string;
if (override !== undefined) {
  if (!CALVER.test(override)) {
    console.error(
      `bump: "${override}" is not YYYY.M.COUNTER (month 1-12 unpadded, counter without leading zero)`,
    );
    Deno.exit(1);
  }
  next = override;
} else {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const m = current.match(/^(\d{4})\.(\d{1,2})\.(\d+)$/);
  const sameMonth = m && Number(m[1]) === year && Number(m[2]) === month;
  next = `${year}.${month}.${sameMonth ? Number(m![3]) + 1 : 0}`;
}
if (next === current) {
  console.error(`bump: already at ${current}`);
  Deno.exit(1);
}

// Each entry names the exact string it rewrites. Verify every pattern BEFORE writing anything:
// a missed home is how versions drift, so a non-match is an error and no file changes.
const edits = [
  { path: "deno.json", pattern: /("version":\s*")[^"]+(")/, replace: `$1${next}$2` },
  { path: "src/version.ts", pattern: /(export const VERSION = ")[^"]+(";)/, replace: `$1${next}$2` },
  { path: "docs/install.sh", pattern: /(RADIA_VERSION=v)[\d.]+/, replace: `$1${next}` },
];
const texts = new Map<string, string>();
for (const e of edits) {
  const text = await Deno.readTextFile(file(e.path));
  if (!e.pattern.test(text)) {
    console.error(`bump: no version string matched in ${e.path}; nothing was written`);
    Deno.exit(1);
  }
  texts.set(e.path, text);
}
for (const e of edits) {
  await Deno.writeTextFile(file(e.path), texts.get(e.path)!.replace(e.pattern, e.replace));
  console.log(`  ${e.path}`);
}

console.log(`\n${current} -> ${next}\n`);
console.log("release it:");
console.log(`  git commit -am "v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push origin main v${next}`);
