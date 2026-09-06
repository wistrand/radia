# song-creator

A seed describes a song. An arranger turns it into a brief, three players write one part each in
parallel, two reviewers judge the result blind, and what they agree on is rendered to a WAV and
served as a page you can open and play.

```
song_request -> brief -> part x3 (parallel) -> phrase x3
             -> draft -> review{by:rules} + review{by:ear}   (different claimants, neither sees the other)
             -> verdicts merged -> revise, or render -> workspace{song.wav, index.html}
```

## Run it

```bash
radia dev --db &                                                # a space
radia team up examples/teams/song-creator --init --seed         # first time: mint, seed, run
radia team up examples/teams/song-creator --init --seed --fresh # a NEW song, members starting cold
deno task test:song                                           # the pipeline, no models      (~5s)
deno task test:song-team                                      # the team wiring, no models   (~5s)
```

Both tasks run with no API key and no harnesses: every model turn is scripted. `test:song` proves
the pipeline, `test:song-team` proves that `team.json` describes a team that actually runs, by
reading that file and minting its members from it.

The assertion that carries the example is `24 faults -> 0`. Round one is written to contain the
mistakes parallel authoring actually makes, and the review has to reduce a measured fault count. An
example that only asserted "the agents produced a file" would keep passing once the review stopped
working.

## Who is on the team

| member | what it is | claims |
|--------|------------|--------|
| `arranger` | a model | `song_request` |
| `ada`, `ben`, `cy` | models, one instrument each | `part` matching their instrument |
| `critic` | a model, the ear | `review {by: "ear"}` |
| `checker` | a program | `review {by: "rules"}` |
| `producer` | a program | `phrase` and `verdict` |

**A player has a name, and plays an instrument it is expert in.** The two are deliberately different
strings. The instrument is a standing property of the player, declared as its claim pattern and
written into its prompt, not something a record hands out per round. Nothing stops two players
declaring the same instrument: they both listen for that part, the lease means one of them gets it,
and the piece still has one lead line. `test:song-team` mints an understudy on `lead` and asserts
exactly that, so the property is checked rather than claimed.

The three players and the critic run WARM (`"resume": true`): one harness session each across rounds.
A player's revision starts with the part it already wrote in context and reads only what the
reviewers asked, so its resumed prompt names no instrument, because the session already knows. The
critic keeps its own earlier verdict, which is what lets it ask whether the changes it requested were
actually made, and whether the piece got worse while satisfying them.

The `checker` has no memory at all and is not meant to. It scores each draft from nothing, so its
verdict never drifts with the conversation, and the two reviewers now differ in what they can do as
well as in how they judge.

To add a fourth player, copy a member, give it the pattern for the instrument it plays, and write it
a prompt. To add an instrument, add it to the arranger's list and give `synth.ts` a voice for it.

## What the review counts, and why it counts dullness

A first live run produced eight bars that were functional and weak: 32 unbroken quarter notes in the
bass, two note lengths in the whole piece, and the bass in D major under a tune in D minor. Nothing
was broken. Nothing was interesting either.

The cause was the scoring. Every measure was a NEGATIVE, so the loop optimised toward the safest
music that has no faults, and it penalised the two things that make a tune: a leap was a fault, and a
borrowed note was out of key. Four changes:

- **The brief carries a chord per bar.** Prose guidance cannot make three parts written apart agree
  about the harmony, which is how the modes came out different. On the strong beats of a bar, a note
  outside that bar's chord is now counted.
- **Dullness is a fault.** A part that is one note length throughout, or plays the same bar over and
  over, or covers less than a fourth, is counted. The loop optimises what it measures.
- **Character is not punished.** A leap counts only if it is not answered by a step back, and a note
  outside the key counts only if it is landed on rather than passed through.
- **The ear settles the piece** once the count is low, instead of needing the arithmetic to be
  perfect. Before, the counter was a veto and the critic advisory, so a live run ended on the round
  limit with the critic's approval ignored.

Measured on that run's own final score, and on one written to its chords with a rhythm:

| | the live run | written to the chords |
|---|---|---|
| total | 56 | 6 |
| off chord | 25 | 5 |
| out of key | 12 | 0 |
| dullness | 4 | 0 |

## Two reviewers, and why they are two agents

`rules` is arithmetic and `ear` is a model. They claim separate `review` records, so they work at the
same time and neither sees the other's verdict before writing its own. What each caught is written to
a `note` per round, so the asymmetry is a fact the run records: the checker finds four parallel
fifths and will never notice that the melody is dull.

In `test:song` a grant pattern on `by` means the model cannot write the rules verdict at all, refused
on the body by the space. A live team does not get that for free, because `radia team add` scopes a
member's grants to the team and nothing else. To have it, tighten the grant after `--init`:

```bash
radia put grant '{"principal":"agent:critic","kind":"verdict","operations":["put"],
                  "pattern":{"team":"song-creator","by":"ear"}}'
```

## Hearing it

The producer mints a capability over the rendered tree and puts the link on the final note, so the
`done` record ends with a URL you can open. It needs no credential: every artifact was checked
against the producer's read grant once, at mint, which also makes the link itself the secret.

That link is SHORT-LIVED. A capability lives in the space's memory for `downloadCapabilitySeconds`
(300 by default) and does not survive a restart, while the tree it points at is permanent. So the
note carries `urlExpiresAt`, and a fresh link is one mint away:

```bash
deno run -A examples/teams/song-creator/share.ts                    # the newest song
deno run -A examples/teams/song-creator/share.ts --workspace song-btfhd0gk
```

For a copy on disk instead, export the tree as a git repository and clone it:

```bash
radia workspace-git song-btfhd0gk --dir /tmp/song && git clone /tmp/song ~/song
```

The link only works if the space runs its artifact origin, which is the default. Started with
`--artifact-port 0` there is no second origin, and the mint hands back a path with no host.

## What each file is

| file | what |
|------|------|
| `score.ts` | the notation and its validator, shared so the renderer and the reviewers cannot disagree |
| `analysis.ts` | metrics over a parsed score: clashes, parallel fifths and octaves, out-of-key notes, leaps, whether it resolves |
| `synth.ts` | the renderer: four waveforms, an envelope per note, one filter, a pan per part, seeded noise so a score renders to the same bytes every time |
| `checker.ts` | the `rules` reviewer as a service, and `judge()` for the smokes |
| `producer.ts` | the spine: fan-in, review dispatch, merging two verdicts, counting rounds, rendering |
| `kinds.ts` | the record vocabulary and the grants per role |
| `share.ts` | a fresh URL for a song already rendered, since the producer's link expires |
| `smoke.ts`, `smoke-team.ts` | the pipeline, and the team wiring, both model-free |

## Things that bite

**Every kind here indexes `team`.** A member's grants are patterned on that field, so a kind that
does not index it can hold no grant that compiles, and a record written without it is one no member
can read. The MCP adapter fills the field in for a harness member after the space refuses one write;
the two services hold plain SDK clients and stamp their own.

**The fan-in is keyed twice, and both were bugs first.** Three players finish in parallel and every
one asks whether the round is complete, so the draft is written under a key on the song and round.
The same is true of the two verdicts: both can be written before either is claimed, so both handlers
see a complete round, and the finished song is keyed on the song. Without that the piece rendered
twice and the team announced itself finished twice.

**Nothing here can hear the audio.** The `ear` critic reads the score, not the waveform. It sounds
like a chiptune, because it is one: a tracker with no samples and no reverb.

**A warm session outlives the song, so a new one wants `--fresh`.** The harness session id survives
the verb by design, so without it the first claim of a NEW song arrives in the session that finished
the last one and the member is handed its RESUMED prompt. On a live run that made all three players
answer as if revising a piece that did not exist, in a format the resumed prompt had not taught
them: 122 parse errors in round one. Two things changed. `--fresh` now drops this team's warm
sessions along with its open tasks, and both resumed prompts check the record's `round` and treat
round 1 as a new song even in a session that remembers the last.

**Unclaimed work is never swept by the space**, so `--fresh` is what retires it. It covers every kind
this team claims, read from the members' patterns and their `take` grants, and both available records
and ones a killed run still has leased. Two live runs found the gaps: sweeping `task` alone missed
this team's kinds entirely, and then sweeping only AVAILABLE records missed a stopped run's leases,
which lapse lazily. Both times a previous song's parts were handed out beside the new seed and two
songs were written at once.
