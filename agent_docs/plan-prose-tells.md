# Plan: the drumroll class of AI-isms in user-facing prose

**Status: DONE 2026-08-18** (rule in CLAUDE.md style, fixes applied across the site and the chat
README, guard live in `conformance/docs.test.ts` and proven RED against the unfixed site first).
Analysis 2026-08-18, from one flagged sentence:

> This is where the shared space earns its keep, and where most systems have nothing to offer.
> (docs/index.html)

## The diagnosis

The sentence commits three moves, and they are one disease: IT CONTAINS NOTHING A READER CAN
CHECK OR USE.

- **Idiom as merit**: "earns its keep" performs value instead of stating it.
- **Significance announcement**: "this is where" is applause for a point not yet made. The
  sentence's only content is that the author finds the next sentence impressive.
- **Unfalsifiable sweep**: "most systems have nothing to offer" names no system and no missing
  mechanism, so it cannot be wrong and therefore says nothing.

The existing AI-ism rules (CLAUDE.md Documentation Style) missed this because they are LEXICAL
(no em dash, no "seamlessly", no rule-of-three) and this class is STRUCTURAL: it survives any
word swap. The review test that catches it:

**After each sentence, ask what the reader now knows. If the answer is "that the author finds
the next point impressive", delete it or replace it with the checkable consequence.** A
comparative claim names the competitor and the missing mechanism ("Temporal dispatches by
function name and treats the payload as opaque, so there is no point where this question can be
asked"), never "most systems".

The cure is never a reworded drumroll. Usually the checkable consequence already exists nearby,
because the drumroll was written as a transition TOWARD it; the fix is deletion plus, at most,
promoting the concrete sentence.

## Inventory (docs site + shipped READMEs, 2026-08-18)

Fix (the disease):

| Site | Line | Move |
|---|---|---|
| docs/index.html:151 | "This is where the shared space earns its keep, and where most systems have nothing to offer" | all three |
| docs/workspaces.html:88 | "This is the part worth being pedantic about, because…" | announcement (second half has the content; lead with it) |
| docs/workspaces.html:408 | "Start with the one that is a genuine operational win" | announcement + praise |
| docs/examples.html:71 | "The interesting part is what you will not find in the source" | announcement prefix on a real observation; trim the prefix |
| docs/examples.html:135 | "it is where this design gets stress-tested" | idiom; state the fact (hardest workload, bugs surface here first) |
| docs/examples.html:161 | "The verdict is the line worth pausing on" | announcement |
| docs/examples.html:204 | "What makes it worth reading is what it does not have" | same shape as :71 |
| docs/examples.html:259 | "a surprisingly good way to spot" | praise adverb |
| examples/chat/README.md:765 | "the second channel earns its keep on structure" | idiom as merit |

Keep (tell-words in semantic use, which is why the guard below is a curated phrase list and not
a word blocklist): "genuinely working" (the lease contract), "genuinely compete" (the storage
table), "genuinely does serve many people" (delegation). Borderline, keep with judgment:
"Almost none of them do both" (why.html; the page then names each system, so it is checkable),
"structurally absent … a nicer property than a careful check" (a real comparison; sharpen
"nicer" to the claim, "stronger", if touched). One tic to ration rather than ban: "the honest
answer/position/limit" appears four times across the site; candor markers read as voice once and
as a verbal habit at four.

## The fix

1. Rewrite the nine sites above: delete the drumroll, promote or add the checkable consequence.
   Worked example for the flagged sentence — delete it; the section already opens with the
   concrete mechanism ("Because the document is a record rather than an argument to a function
   call, the runtime can look at it") and already ends with the named-competitor contrast.
2. Sweep the same classes through the remaining user-facing prose in one pass: the other
   READMEs, `docs/llms.txt`, MCP tool descriptions (`src/surfaces/mcp/tools.ts`), console
   strings. agent_docs/ is internal and lower priority; apply the rule opportunistically there.
3. **The guard**: a style case in `conformance/docs.test.ts`, site-only (pages + llms.txt, with
   `<pre>` and `<svg>` stripped), over a CURATED always-wrong phrase list plus the em dash.
   BUILT, and proven RED against the unfixed site first (it caught all eight phrase hits and the
   three dashes), per the layering-test discipline. It carves out the file's own "structural
   only, nothing matches wording" doctrine explicitly: these phrases are never a rephrase of a
   claim, so a rephrase cannot trip the test. Judgment tells (genuinely, honest, "this is
   where") stay OUT of the guard and IN the review rule: they have legitimate uses, and a guard
   that cries wolf gets deleted.

## The second sweep: four more structural classes, and two cleared

Counted over the site's ~13,500 words of prose, 2026-08-18; all fixed the same day where marked.

1. **Antithesis as a metronome.** ~70 contrast frames ("rather than" 45, ", not" 17, "instead
   of" 8), one per paragraph on average, twelve "rather than" on workspaces.html alone. Two
   species: the INFORMATIVE contrast names a concrete rejected alternative ("a chain of records
   rather than a mutable directory") and stays; the POLISHED ABSTRACT INVERSION ("enforced
   rather than encouraged", "a decision rather than a gap", "a hole rather than an
   inconsistency") is ornament stamped from one mold. Rule: never two in a paragraph, and when
   both nouns are abstractions, rewrite one side into the actual thing. Fixed the five worst on
   workspaces.html; doctrine phrases ("discovered rather than configured", "refused rather than
   run") kept.
2. **Q&A self-dialogue outside the FAQ.** why.html's question headers are the genre and stay;
   "the honest answer is that" staged elsewhere is the tic. Fixed (inspection, examples). Rule:
   outside a FAQ-shaped page, state the fact without staging the question.
3. **Candor and intent theatrics.** "honest" x7, "deliberately" x4, "on purpose" x3: prose
   certifying its own honesty reads as protesting too much. The fact of a limitation IS the
   honesty. Fixed the three "honest answer/position" formulas; semantic uses kept. Rule: about
   one candor marker per page.
4. **"exactly" as intensifier.** Counted 11, but most are quantity or identity uses ("exactly
   one lease", "materialises exactly that version") and stay; two pure intensifiers fixed. Rule:
   keep only where it disambiguates.
5. **Em dashes on the site**: three, all violations of the EXISTING lexical ban, all introduced
   within days of the rule being restated. Fixed, and the char joined the guard: the lexical
   bans had no enforcement either.

Cleared with reasons, so nobody re-litigates: "refuses/refused" (x20) is the system's documented
semantic (fail-closed, 403), not anthropomorphic decoration; sentence-initial "And"/"So" (16/6)
is conversational register at tolerable density; the two negated triads ("no replay verb, no
invalidation pass, no 'mark stale' flag") each name three real absent mechanisms, which is
enumeration, not rhythm; aphorism closers are rare on the site.

The shared shape of every class, including the drumroll: INVISIBLE TO WORD-LEVEL RULES. Each
instance is defensible alone; the disease is frequency or staging. That is why the guard bans
only the always-wrong phrases and the review rule owns the rest.

## Avoiding repetition

- CLAUDE.md Documentation Style gains the structural rule (one bullet, the reader-knows test and
  the named-competitor rule). DONE with this plan.
- Memory note (feedback) so the rule survives session boundaries. DONE with this plan.
- The guard (step 3) is the durable half for the site, which is the surface that drifts: it is
  the one place "update the doc in the same change" is not written down next to the text.
