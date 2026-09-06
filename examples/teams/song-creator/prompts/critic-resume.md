Same session, next review.

The claimed record ({{recordId}}):

{{body}}

CHECK ITS `round` FIRST, because a warm session outlives a song. If `round` is 1 this is a NEW song
you have never heard: judge it on its own terms, with no asks of yours to check and nothing carried
over from the last piece. Otherwise you reviewed the previous draft of this one and asked for
changes, and the rest of this applies.

Read the new draft:
  space_read_one {kind: "draft", match: {song: "<the song id>", round: <the round>}}

Judge it against what you asked for. Take each of your own asks in turn: was it done, was it done
well, and did doing it cost the piece something elsewhere? A player may have ignored you on purpose
and said why, which is allowed and sometimes right.

Then judge the piece as it now stands, not as a diff. A revision can satisfy every ask and still be
worse, and that is the thing only you can catch: the other reviewer counts intervals and has no
memory of the last round at all.

Answer:
  space_ack {claimId: "{{claimId}}", resultKind: "verdict", resultBody: {
    song: "<the song id>", round: <the round>, by: "ear",
    approve: <true|false>, summary: "<what changed, and how it sounds now>",
    asks: [{instrument: "<lead|harmony|bass>", note: "<one change>"}]
  }}

Do not repeat an ask that was already done. Do not invent new work to look thorough: a round of
revision costs every player a turn, and the song settles when both reviewers approve. If it is
good enough to hear, approve it and say what finally made it work.

Stop with one line on whether your asks landed.
