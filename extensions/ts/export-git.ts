// Export a workspace's history as a git repository.
//
//   deno task workspace-git --name <workspace> --dir <out> [--url <space>] [--conversation <id>]
//
// The credential is the caller's, passed in and never discovered: this is a client like any other,
// and an export reads exactly what its principal may already read. `radia login <principal>
// --compact` prints a token suitable for RADIA_TOKEN.
//
// The result is a BARE repository, so git does the checkout:
//
//   git clone <out> my-checkout
//
// Read-only in the strong sense: nothing flows back. Commit there, push there, rewrite there — the
// space neither knows nor cares, and re-exporting overwrites what you did. See
// agent_docs/design-workspaces.md for why import is refused rather than unimplemented.

import { RadiaClient } from "../../sdk/ts/client.ts";
import { exportWorkspaceGit } from "./git.ts";

// A local flag reader, which `src/flags.ts` otherwise forbids. The exception is structural, not
// laziness: an extension may not import `src/` (conformance/layering.test.ts enforces it), so the
// shared parser is out of reach here. This file exists for the npm-package consumer who has the SDK
// and the extensions but no `radia` binary; with the binary, `radia workspace-git` is the same
// export through the shared parser.
function flag(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : undefined;
}

const name = flag("name");
const dir = flag("dir");
if (!name || !dir) {
  console.error("usage: --name <workspace> --dir <output> [--url <space>] [--conversation <id>] [--branch <name>]");
  Deno.exit(2);
}

const token = flag("token") ?? Deno.env.get("RADIA_TOKEN");
if (!token) {
  console.error("no credential: pass --token or set RADIA_TOKEN (radia login <principal> --compact)");
  Deno.exit(2);
}

const url = flag("url") ?? Deno.env.get("RADIA_URL") ?? "http://127.0.0.1:7788";
const client = new RadiaClient(url, { token });

const result = await exportWorkspaceGit(client, name, dir, {
  conversationId: flag("conversation"),
  branch: flag("branch"),
});

const branches = Object.entries(result.branches);
console.log(
  `${name}: ${result.versions.length} version${result.versions.length === 1 ? "" : "s"}, ` +
    `${result.objects} objects, ${(result.bytes / 1024).toFixed(1)} KiB -> ${result.dir}`,
);
for (const [branch, commit] of branches) {
  console.log(`  ${branch === result.head ? "*" : " "} ${branch} ${commit.slice(0, 12)}`);
}
// A fork is the one outcome a reader must not skim past: two heads mean somebody else wrote a
// successor to the same version, and neither side's work is lost or merged.
if (branches.length > 1) {
  console.log(`  this workspace FORKED: ${branches.length} heads, none merged. git log --graph --all`);
}
console.log(`  git clone ${result.dir} my-checkout`);
