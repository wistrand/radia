# Plan: `radia update`, self-replace (signing designed, deferred)

**Status: PHASE 1 BUILT 2026-08-30** (`src/surfaces/update.ts`, `radia update [--check]
[--release <tag>]`, five platform-seam additions, `test/update.test.ts`). **PHASE 2 BUILT** the
same day (README, `docs/index.html`, `architecture-surfaces.md`). The signing phases are open and
deliberately so; see the verdict below. Claims about current behaviour were verified against
source the same day, and the Ed25519 result below was measured rather than looked up. The
signing half is designed and DEFERRED; the verdict and its triggers are in "Is signing worth it".

## What exists today

`docs/install.sh` is the one supported install, and re-running it is the only upgrade path. It
downloads `radia-<target>.gz`, fetches the release's `SHA256SUMS`, refuses when that file does not
list the asset (a missing line means nothing was verified), runs `radia version` from the temp
directory before installing, and `mv`s the binary into `~/.local/bin`. `RADIA_VERSION` pins a
release and `RADIA_BASE_URL` points at a mirror.

Three facts shape everything below:

- **The checksum defends against a corrupted download and a swapped asset, and against nothing
  else.** The expected hashes arrive over the same connection as the bytes, which `install.sh` says
  in its own header. `RADIA_BASE_URL` makes mirrors a supported path, so the set of parties that
  can serve a hash is larger than the set that publishes one.
- **Nothing tells anyone a release exists.** `radia version` reports this build and checks nothing.
- **Ed25519 verification needs no dependency.** Measured on Deno 2.9.2 stable: Web Crypto
  `generateKey`/`importKey("raw")`/`verify` with `{name:"Ed25519"}`, 32-byte public key, 64-byte
  signature, a tampered message rejected. So the verifier is Web Crypto and a 32-byte constant,
  not a library.

## Decisions

### Signing, deferred

**Sign `SHA256SUMS`, never the assets.** That file already covers every target and is already
fetched by both consumers, so one signature carries the whole release whatever the target count.
The asset is `SHA256SUMS.sig`, one line, `<kid> <base64 signature>`.

**The public key names itself, and an unknown key is a ROTATION rather than damage.** `kid` is
derived from the key (leading hex of its sha256) so two builds agree without being told, which is
the rule `src/storage/crypto.ts` already applies to `SealedKey.kid`. A build embeds a key SET (a
new `release-keys.ts` beside `src/version.ts`), and a signature whose `kid` it does not know is
reported as "this build predates the key that signed that release, reinstall with install.sh",
never as tampering. Without this, rotating the key turns every older binary's update path into an
accusation.

**Verification is mandatory and there is no `--insecure`.** A flag that skips it is a flag an
attacker wants set. When the signature cannot be checked the verb refuses and names the install
line; it never falls back to checksum-only.

### The verb

**The verb never elevates.** If the binary's directory is not writable by this user it fails naming
the path and its owner, and prints the `install.sh` line. Never `sudo`, never a re-exec.

**Replace in place, atomically, keeping the installer's pre-flight.** Write the new binary to a
temp name IN THE TARGET DIRECTORY, `chmod 0755`, run `<tmp> version` and require the version it
reports to match the release being installed, then `rename` over the target. The temp file must not
be in `/tmp`: that is usually a different mount, and `rename` across filesystems fails `EXDEV`.
Replacing a running binary is safe on Unix because the open inode survives the rename, so the
process that ran `update` keeps executing the old image to completion.

**Learn the latest version without the GitHub API.** GET `releases/latest/download/SHA256SUMS` and
read the tag out of `response.url` after redirects, which is the trick `install.sh` already uses to
avoid the 60-per-hour unauthenticated API limit that bites shared networks first. `--check`
therefore costs one request.

**Surface: `update` is the second verb about this MACHINE rather than a space**, after
`credentials`. It holds no token, contacts no space, and takes no value from `src/core`.

```
radia update              # replace this binary with the latest release
radia update --check      # report only; exit 1 when an update is available
radia update --version v2026.8.1   # install a named release, downgrade included
```

`--version` exists because a bad release needs a way back that is not "find the old tag yourself".

## What this does not buy

The signing key lives wherever the release workflow can reach it, which means a GitHub Actions
secret. So the signature defends against a compromised `radia.sh`, a compromised mirror or CDN, and
a tampered asset in transit or at rest. It does not defend against a compromised release workflow,
a compromised repository, or anyone who can push a `v*` tag: all of them can sign. First install is
still `curl | sh` trusting whoever serves the script, which no signature here changes.

The honest one-line version: **the first install trusts radia.sh, every update after it trusts the
key.**

## Is signing worth it: NOT YET, and this is the decision

There is no separate trust root to defend. `radia.sh` is GitHub Pages published from this repo
(`.github/workflows/pages.yml`), the assets are this repo's releases, and the signing key would be
an Actions secret on this repo. Compromise one and you hold all three, so a signature adds nothing
against the party it is normally sold against.

What it WOULD buy is narrow and real: release assets are mutable by hand (`gh release upload
--clobber`, which the workflow itself uses), so a key only CI holds distinguishes an asset the
tagged build produced from one a person uploaded. With one maintainer that is the same person.

Against that: a private key is a permanent custody liability (losing it stops releases, leaking it
is worse than having none, since it looks authoritative where "we do not sign" does not); rotation
is load-bearing code that runs almost never; and mandatory verification makes signing a hard
dependency of shipping, since a release without a `.sig` becomes uninstallable by the verb.

**So build the verb, keep the checksum, defer the signature.** Reserve the `SHA256SUMS.sig` name
and the `<kid> <base64>` line here so adding it stays additive and no older binary breaks. Sign
when a trust root actually splits, which is one of:

1. A mirror is in use, so bytes and hashes stop coming from one place this repo controls.
2. More than one person can push a `v*` tag, or releases stop being one workflow.
3. There is a user with something to lose ([research-positioning.md](research-positioning.md)
   still opens with "no second user").

Everything above about HOW to sign stands and is what to build when one of those fires. The
sections below are ordered on this decision.

## Phases

1. **The verb, checksum only. BUILT.** `src/surfaces/update.ts`, dispatched from
   `src/surfaces/cli.ts` beside `version` and ahead of the client, since both must answer with no
   space, no credential and no base URL. `--release <tag>` rather than the `--version` this plan
   first wrote: `--version` is already a global alias for the `version` verb in this same CLI, and
   a flag that means two things is the papercut class plan-startup-ergonomics.md catalogues.
   Verifies the asset against the release's `SHA256SUMS` exactly as the installer
   does, and refuses when that file does not list this target. This is the whole of the day-one
   value: nothing today can tell anyone a release exists.
   FIVE additions to the platform seam, not the two this plan predicted:
   `makeExecutable` and `realPath` as expected, plus `buildTarget()`, `isStandalone()` and
   `runCapture()`. The first two removed work rather than adding it. `Deno.build.target` IS the
   release triple, so the verb needs no uname mapping and no musl check the way `docs/install.sh`
   does: a binary that is running is one this machine can run. `Deno.build.standalone` is the
   guard that had no place in the plan and is the most important line here, since `execPath()`
   from a checkout names the `deno` executable and `deno task cli update` would otherwise have
   overwritten it (verified: it refuses). `runCapture` is process execution entering `src/` for
   the first time; it is documented as having one caller, because the pre-flight cannot happen
   without it. `execPath`'s doc comment said "Never used to re-exec" and now says what it IS for.
2. **Docs. BUILT.** README (install, Distribution, and the deployment paragraph that owed an
   upgrade procedure, now narrowed to what the verb does not do: it swaps a binary and decides
   nothing about restarting or rolling back a space), `docs/index.html`, and
   `architecture-surfaces.md`, where the verb is documented as the SECOND reader of the asset-name
   contract. The verb-list guard in `test/docs.test.ts` was widened during phase 1 rather than left
   as a trap: it read `case "x":` only, so `version` and `update`, which are answered by an `if`
   ahead of the switch, would have been reported as verbs the CLI does not have the moment the site
   named one. Every page states that releases carry checksums and no signature, since a reader who
   assumes otherwise is the one this decision could hurt.

Deferred until a trigger above fires, in this order:

3. **Key and embed.** Generate the pair, commit the public half to a new `release-keys.ts` beside
   `src/version.ts` with its derived `kid`, store the private half as an Actions secret.
4. **Sign in `release.yml`.** Append `SHA256SUMS.sig`. Additive: the installer and every existing
   binary ignore it.
5. **Verify in the verb**, mandatory, per the decisions above.

## Guards

- The asset-name contract across `install.sh`, `release.yml` and the verb, extending the existing
  test in `test/docs.test.ts` rather than adding a second one. Phase 1 already makes it three files.
- A planted bad CHECKSUM is refused, proved red before it is proved green. A structural test
  nobody has seen fail is one nobody has tested. The signature guards below come with phase 5:
  a planted bad signature refused, and an unknown `kid` reported as rotation rather than tampering.
- A `SHA256SUMS` that does not list this target's asset is refused, matching the installer.
- The whole path runs against a loopback server serving a fake release, reusing `RADIA_BASE_URL` so
  the override has one name and two consumers.

## Rejected

- **Sigstore / cosign keyless.** It removes the long-lived key, which is the real weakness here,
  and costs a Fulcio and Rekor trust root plus a verifier far larger than the Web Crypto call it
  replaces. Against the minimal-dependency invariant. Revisit if this project ever has a release
  team rather than one person.
- **GPG.** A binary dependency, a keyring, and a verification step people skip.
- **minisign format compatibility.** A format to parse for a compatibility nobody asked for. The
  file is read by this binary and by no other tool.
- **Verifying the signature inside `install.sh`.** Ed25519 in shell needs OpenSSL 3.x, which the
  script does not currently require (curl, uname, gzip, sha256sum). Adding it would make the
  guarantee depend on the host's OpenSSL and would still not protect the first install, which is
  the one that trusts the script itself. An OPTIONAL check when OpenSSL 3 is present is possible
  and is not decided here; it buys little and makes the guarantee non-uniform.
- **A background update check.** The runtime logs and a surface prints; a phone-home on `radia dev`
  is telemetry nobody asked for and a startup dependency on the network. `--check` is explicit, and
  a schedule is the operator's to write.
- **Re-exec after replacing.** A verb that swaps the binary and then runs it is a different trust
  decision from one that swaps it. Print what changed and exit.
