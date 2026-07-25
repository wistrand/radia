# Vendored assets

Third-party browser assets served by the dev console. Checked in as prebuilt artifacts so
`deno task dev` stays a zero-build run-from-source.

## `blitzoom.bundle.js`

BlitZoom — deterministic property-similarity layout + hierarchical zoom, used by the console's
**Space** tab (`<bz-graph>`). Positions records by what they *are* (kind, state, principal), not
by what they are connected to, which is the visual analogue of content routing.

| | |
|-|-|
| Upstream   | `https://github.com/wistrand/blitzoom` (local checkout `../blitzoom`) |
| Commit     | `43b6efaf23d82b73e4d425ba50aaac7f20cb06dd` (2026-07-20) |
| Built with | `deno bundle --minify docs/blitzoom.js` |
| Size       | 211 KB minified, no runtime dependencies |
| License    | see upstream |

Refresh with:

```sh
cd ../blitzoom && deno bundle --minify docs/blitzoom.js \
  > ../radia/src/ui/vendor/blitzoom.bundle.js
```

Then update the commit hash above. Do not hand-edit the bundle.

The console loads it lazily — the script tag is injected the first time the Space tab is opened,
so the default console load stays small. Served at `GET /ui/blitzoom.bundle.js` (public, like
`GET /`, so the console can bootstrap in auth-required mode).
