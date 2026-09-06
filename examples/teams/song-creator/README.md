# song-creator

A seed describes a song. An arranger turns it into a brief, three or four players write one part each
in parallel, two reviewers judge the result blind, and what they agree on is rendered to a WAV and
served as a page you can open and play.

```
song_request -> brief -> part per player (parallel) -> phrase per player
             -> draft -> review{by:rules} + review{by:ear}   (different claimants, neither sees the other)
             -> verdicts merged -> revise, or render -> workspace{song.wav, round-N.wav, index.html}
```

## Run it

```bash
radia dev --db &
radia team up examples/teams/song-creator --init --seed          # first time
radia team up examples/teams/song-creator --seed --fresh         # a NEW song, members starting cold
radia team up examples/teams/song-creator --seed --fresh \
  --seed-body '{"description":"a slow waltz for a rainy afternoon"}'   # ask for something else

deno task test:song        # the pipeline, every model turn scripted   (~10s)
deno task test:song-team   # the team file itself: kinds, grants, services (~6s)
```

Both tasks run with no API key. A live run costs five model turns per round and takes two to four
minutes.

## Who is on the team

| member | what it is | claims |
|--------|------------|--------|
| `arranger` | a model | `song_request` |
| `ada`, `ben`, `cy` | models, one instrument each | `part` matching their instrument |
| `pip` | a model, the drummer, asked only sometimes | `part` matching `drums` |
| `critic` | a model, the ear | `review {by: "ear"}` |
| `checker` | a program | `review {by: "rules"}` |
| `producer` | a program | `phrase` and `verdict` |

**A player has a name and plays an instrument it is expert in.** The two are deliberately different
strings: the instrument is a standing property of the player, declared as its claim pattern and
written into its prompt, not something a record hands out per round. Nothing stops two players
declaring the same instrument, and `test:song-team` mints an understudy on `lead` to prove the lease
still yields one part per round.

**The drummer is optional and the arranger decides**, by what it puts in `brief.parts`. An unasked
member costs nothing, because a harness is launched only when a record is claimed for it.

The players and the critic run WARM (`"resume": true`), one harness session each across rounds. The
`checker` has no memory and is not meant to: it rescores every draft from nothing, so the two
reviewers differ in what they can remember as well as in how they judge.

## What the review counts, and why it counts dullness

A first live run produced eight bars that were functional and weak: 32 unbroken quarter notes in the
bass, two note lengths in the whole piece, and the bass in D major under a tune in D minor.

The cause was the scoring. Every measure was a NEGATIVE, so the loop optimised toward the safest
music with no faults, and it punished the two things that make a tune: a leap was a fault and a
borrowed note was out of key. Four changes:

- **The brief carries a chord per bar.** Prose cannot make parts written apart agree about harmony,
  which is how the modes came out different. A note on a strong beat outside its bar's chord counts.
- **Dullness is a fault.** One note length throughout, the same bar repeated, or a range under a
  fourth. The loop optimises what it measures.
- **Character is not punished.** A leap counts only if unanswered; an out-of-key note only if landed
  on rather than passed through.
- **The ear settles the piece** once the count is low, instead of needing the arithmetic perfect.

`groove: true` on the brief is the one field that turns a measurement off: it exempts the rhythm
section from the one-note-length rule, because a pumping eighth-note bass under a four-on-the-floor
kit is the genre and only the brief knows that was meant.

Measured across live runs of the same request:

| | first run | after the four changes |
|---|---|---|
| total faults, final round | 56 | 2 |
| off the bar's chord | 25 | 0 |
| out of key | 12 | 0 |
| dull parts | 4 | 0 |
| rounds to settle | 3, on the limit | 3, on the ear |

## The page

The finished song leads: title, player, two lines of plan. Under "How it got there" a LANE VIEW
borrowed from `radia activity` gives every agent a row, with marks placed by TIME across the run and
the rounds drawn on that axis as dotted rules. It answers what a list of rounds cannot, because the
shape is across rounds: which part was slow, which kept being sent back, and who asked. Each round
then folds into a `<details>`, closed except the last, which needs no script because a shared
workspace is served under `default-src 'none'`.

Rejected rounds render at half the sample rate and the final at full: what is interesting about a
take nobody chose is what it sounded like, not its fidelity.

## Hearing it

The producer mints a capability over the rendered tree and puts the link on the final note, so the
`done` record ends with a URL that needs no credential. It is SHORT-LIVED (the space's
`downloadCapabilitySeconds`, 300 by default) and dies with a restart, while the tree is permanent:

```bash
deno run -A examples/teams/song-creator/share.ts                    # a fresh link, newest song
radia workspace-git song-XXXXXXXX --dir /tmp/song && git clone /tmp/song ~/song   # a copy on disk
```

It sounds like a chiptune with a beat. The renderer is a tracker: detuned oscillator stacks, one
filter that closes as a note sounds, a sub under the bass, and a kit whose pitch picks the drum.
Nothing in the pipeline can hear it; the `ear` critic reads the score.

## What each file is

| file | what |
|------|------|
| `team.json` | the members, their grants, and the KIND VOCABULARY, which `kinds.ts` reads so there is one copy |
| `score.ts` | the notation and its validator, shared so the renderer and the reviewers cannot disagree |
| `analysis.ts` | metrics over a parsed score: clashes, parallels, key, chord tones, dullness |
| `synth.ts` | the renderer, deterministic so a score renders to the same bytes every time |
| `history.ts` | the page: the song first, then the lane view and every round |
| `checker.ts` | the `rules` reviewer as a service, and `judge()` for the smokes |
| `producer.ts` | the spine: fan-in, review dispatch, merging verdicts, counting rounds, rendering |
| `service.ts` | how a service stops: it retires its own run, or it goes on looking alive |
| `share.ts` | a fresh URL for a song already rendered |
| `smoke.ts`, `smoke-team.ts` | the pipeline, and the team wiring, both model-free |

## Why this became a useful example

It is the first example here whose OUTPUT HAS A MEASURABLE QUALITY, so "the review improved it" is a
number that has to move rather than a claim a README makes. Everything else follows from that: the
smoke can assert 15 faults down to 2, a metric that stops discriminating fails a test, and a change
to the prompts is answerable rather than arguable.

It also turned out to be a good shape for finding bugs, because it is the first team here that is
NOT a chat: services beside harnesses, its own claimable kinds rather than `task` with tags, records
written by programs that hold no MCP adapter, and a workspace served to a browser. Bugs it found in
shared code, all fixed and guarded:

- `mediaTypeFor` had no audio types, so a rendered song was served `text/plain` and no browser would
  play it. Every workspace holding audio was affected.
- `--fresh` swept `task` only, so a team routing its own kinds swept nothing and wrote two songs at
  once; and it swept `available` only, missing a killed run's leases, which lapse lazily.
- `~/.radia/team/<member>/` was flat, so `go-fish` and this team shared a working directory, an MCP
  config and a warm session between members that happen to share a name.
- A service that traps SIGTERM outlived `team up` and hung it, then went on claiming with old code.

## Where it caused friction

- **A live run costs real money and minutes**, five model turns per round, so the loop between a
  change and evidence is slow. Both smokes exist to keep that loop off the paid path, and every fix
  above was found by running rather than reading.
- **Models fail at arithmetic in notation.** One run wrote 122 unparseable tokens; two later runs
  lost a round each to bars that did not add up. A round lost to notation is not a round of revision,
  which is why the limit counts rounds that parsed.
- **Warm sessions outlive the song.** The session id survives the verb, so a new song's first claim
  arrived in the session that finished the last one and got the REVISION prompt. `--fresh` now drops
  them, and both resumed prompts check the record's `round`.
- **A member name IS a principal.** This team's `ada`, `ben` and `cy` are `go-fish`'s too, so running
  the two alternately keeps superseding each other's definitions. Distinct names per team would end
  it; the per-team directory does not.
- **Two copies of one vocabulary drifted.** `brief` gained `chords` in TypeScript while `team.json`
  went on describing a plan without them, so every agent that discovered the kind learned the old
  shape. `kinds.ts` now reads the file.

## Things that bite

**Every kind here indexes `team`.** A member's grants are patterned on that field, so a kind that does
not index it can hold no grant that compiles. The MCP adapter fills the field for a harness member;
the two services hold plain SDK clients and stamp their own.

**The fan-in is keyed twice, and both were bugs first.** Three players finish in parallel and each
asks whether the round is complete, so the draft is keyed on song and round. Both verdicts can also
be written before either is claimed, so the finished song is keyed on the song. A verdict for a round
the song has already left decides nothing, or a late handler settles on stale verdicts.

**Unclaimed work is never swept by the space**, so `--fresh` is what retires it, across every kind
the team claims and including a stopped run's expired leases.
