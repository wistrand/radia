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
  on rather than passed through, and never when it is a tone of that bar's chord. `E7` in A minor is
  `E G# B D`, so the G# that makes it a dominant is required by `offChord` and was being punished by
  `outOfKey` at the same time: two rules with opposite verdicts on one note, which no revision can
  satisfy. A live run spent three rounds removing them and settled on the round limit at 21 faults,
  on a piece a listener called the best the team had made. The chord is the local harmony; the key
  is the default it may leave.
- **The ear settles the piece** once the count is low, instead of needing the arithmetic perfect.

Two fields on the brief turn measurements off, and there are only two. `groove: true` exempts the
rhythm section from the one-note-length rule and the bass from the parallel-motion rule, because a
pumping eighth-note bass locked to the harmony under a four-on-the-floor kit is the genre and only
the brief knows that was meant. `riff: true` does the same one part over: it exempts the MELODY from
uniform note lengths, from repeating a bar, and from the late-peak rule, because all three describe
a tune that develops and a motor riff does not. Both are narrow on purpose, and neither excuses
anything else: a riff still has to breathe, and the parts under it are still measured.

**Why the second one was needed is the sharper lesson.** Songs from different requests were coming
back sounding alike, and the cause was not the rules but what reached the players. The arranger's
per-part `guidance` restated the instrument's standing brief ("carry the singable tune in a
comfortable mid-high register, moving mostly stepwise") in words that fit any song; the player
prompts listed what the brief carries and left `description` out of the list; and from round two on
the guidance was `Round N. Keep what works; change only what was asked`, so the sole input was the
checker's fault list. The measured rules encode one aesthetic, and once they are the only signal
left, every request converges on it. The description now travels into every round, guidance has to
say what this piece does that another would not, and a piece whose tune is a figure can say so.

Measured across live runs of the same request:

| | first run | after these four changes |
|---|---|---|
| total faults, final round | 56 | 2 |
| off the bar's chord | 25 | 0 |
| out of key | 12 | 0 |
| dull parts | 4 | 0 |
| rounds to settle | 3, on the limit | 3, on the ear |

## The second correction: dullness is not the same as no repetition

A later run of "a modern pop song with memorable melody" settled at 8 faults and was still weak. The
first correction had overshot: every rule now pushed AWAY from repeating anything, and a hook is a
rhythm that comes back. Reading the settled draft out of the space showed what the count had done:

- the lead spent its highest note in bar 2 of 8 and never went higher
- it never rested once in eight bars, because rests were legal but nothing asked for them
- the bass answered a parallel-motion complaint by replacing its driving eighths with half notes
- the kit played two distinct bars in eight and passed a rule meant to require a fill
- every note in every part landed on or after a beat, because the notation had no tie

Six more changes, each with a guard in `smoke.ts`:

- **A tie, written `~`.** A note may now hold into the next of the same pitch and cross a barline, so
  a part can arrive before the downbeat. That anticipation is most of what separates a pop line from
  an exercise, and it was unwritable.
- **No cell coming back is a fault.** Measured on RHYTHM alone, so the same figure moved to fit the
  next chord counts as the same figure. It leaves a window with the existing repetition rule: some,
  not all.
- **The tune's peak has to be late,** and the tune has to breathe. Both apply to the highest part
  only, since an inner voice sitting still is doing its job.
- **A groove exempts the bass from parallel motion.** The rule is species counterpoint; a rhythm
  section locked in fifths and octaves is the idiom, and enforcing it cost the run its drive.
- **A kit is counted by how many different RHYTHMS it plays,** not by whether any two bars are
  identical. A drum's pitch picks which drum, so moving a hit from hat to snare makes a new bar out
  of the same rhythm: two runs shipped 16 bars holding 5 and 4 distinct bars but one and three
  rhythms each, and the rule passed a part that is one bar sixteen times.
- **A chord entry may name two chords,** `"Bm G"`, splitting the bar. A progression that can only
  turn over on a downbeat cannot write a pre-chorus, and every run before this returned one chord per
  bar because that was all the field could hold.

The lesson generalises past music: **a loop optimises what it measures, and the correction for a
metric that rewards blandness is not simply to punish sameness.** The second metric has to name the
thing you actually want, and repetition and monotony are not opposites.

## The third correction: the shape of the feedback, not the metric

The measurements were then right and the loop still burned rounds, because of how the asks were
BUILT. Three fixes, all in `checker.ts` and `producer.ts`:

- **A cap must count distinct MISTAKES, not occurrences.** Parse errors were deduped by their
  message, which carries the bar number, so one part with eight overlong bars read as eight distinct
  places; the cap of two per instrument handed over two and the player fixed exactly those, four
  rounds running. Key on the RULE and name every bar in one ask.
- **The same, one branch over.** Dissonance is judged at every ONSET, so a clash held across a bar
  reported once per note start: 12 asks covering 4 problems, the budget spent before the rest were
  reached. Deduped by `(kind, bar, parts)`. The COUNT still counts occurrences, because a clash held
  through eight onsets IS worse; only the INSTRUCTION must not repeat.
- **Never ask a model to judge what the deterministic stage already refused.** A draft that does not
  parse cannot be heard, and the ear duly approved four of them, praising a "late C6 payoff" on
  scores the renderer rejects: a paid turn and a false line in the history. The `ear` review is now
  emitted only for a draft that parses, and what a round is OWED comes from the same parse, so
  dispatch and the wait cannot drift.

Same request, before and after all three corrections:

| | before | after |
|---|---|---|
| rounds | 6, on the ceiling | 3, on agreement |
| rounds lost to notation | 4 | 1 |
| ear verdicts on unreadable drafts | 4 | 0 |
| final faults | 21 | 4 |

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

It sounds like a synth record, not an orchestra. The renderer is a tracker with a mixer:
band-limited oscillators (a naive saw folds everything above Nyquist back down as grit, worst on the
highest notes, and a C7 measured 9.3% of its energy inharmonic before this and 3.8% after), a
resonant two-pole filter per note that moves as the note sounds, unison stacks spread across the
stereo field, a sub under the bass, a kit synthesised per hit (a kick that drops in pitch, a snare
that is a tuned body under a rattle, a closed and an open hat), and one room every part sends its
own share to. **The first version of all that sounded like an organ**, and the reasons are worth
keeping: sustains near or above half, a filter that had stopped moving by the end of the decay, a
pad doubling itself at an exact octave (which is what a drawbar is), a square held at a fixed width,
and every note identical to the last. Now a long note either falls away or keeps drifting, the
harmony's pulse width sweeps, the octave copy is nine cents sharp so it beats, and each note is a
few cents and a few percent of level and cutoff away from its neighbours, drawn from a seeded
generator so the render stays repeatable. Measured against the single-oscillator version it replaced, on the same score: channel
correlation 0.97 to 0.83 (a wider record rather than a thicker middle), 6dB more level at the same
peak, and 35ms of CPU per second of audio against 15ms. Nothing in the pipeline can hear it; the
`ear` critic reads the score.

The brief's `timbre` picks which family the pitched parts are played on: `synth`, `plucked` (struck
and left to ring) or `soft` (slow to arrive and held). Voices are chosen by ROLE, so before this
field a brief asking for a harp rendered on the same three-saw lead stack as a dance track and
nothing could say otherwise. It names a FAMILY rather than an instrument, because a tracker with
four waveforms can be a plucked string and cannot be a harp, and a timbre may change the oscillator
and the envelope but never the pan or the gain: those are the arrangement and must survive a change
of sound.

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

## The team declares thinking OFF, and that is a demo decision

Every `claude` member carries `env: {"MAX_THINKING_TOKENS": "0"}`. Two reasons, and the first is
about reproducibility: `~/.claude/settings.json` `alwaysThinkingEnabled` reaches a spawned harness
and nothing in `team.json` can see it, so two operators running this same directory got materially
different members. A team states its own policy.

The second is what the example is FOR. The same request run both ways:

| | thinking on | thinking off |
|---|---|---|
| wall clock | ~15 min | 4m18s |
| rounds lost to notation | 0 | 2 |
| final faults | 1 | 5 |

Thinking buys bar arithmetic, so it produced better music AND a worse demonstration: nothing was
ever refused, so the refusal path, the per-instrument repair ask and the re-round never ran. Off, the
checker refuses two rounds, names the bar that does not add up, each player fixes only its own, and
the piece still settles. THAT is the behaviour this example exists to show, and it is watchable in
four minutes. The music is the workload, not the point.

Two facts before changing it. The value is a SWITCH, not a cap (`1024` produced 2934 thinking
tokens, and a live lead spent 19k). And the players run in PARALLEL, so a round costs
`max(ada, ben, cy, pip)`.

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
