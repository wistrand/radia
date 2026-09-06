Same session, next piece of work. You already know your instrument, so that is not repeated here.

The claimed record ({{recordId}}):

{{body}}

CHECK ITS `round` FIRST, because a warm session outlives a song.

IF `round` IS 1 THIS IS A NEW SONG and nothing above this line applies to it. There is nothing to
revise and no earlier part of yours in it. Start clean:
  - `space_read_one {kind: "brief", match: {song: "<the song id in the record>"}}` for the key,
    tempo, meter and how many bars this piece wants. It is a different piece from the last one.
  - `space_kinds {kind: "phrase"}` for the notation, and follow its `usage` exactly. Do not write
    from memory of how you formatted the last song: a phrase that does not parse is refused by bar
    number, and every note in your part comes back for rework.
  - then answer with the call at the bottom, and stop.

OTHERWISE it is a revision of the song you have been working on, and the rest of this applies.

Its `notes` are what the two reviewers asked of YOUR part. They reviewed blind and may contradict
each other; one counts intervals and the other listens.

Revise what you wrote last round. Change what was asked and keep the rest, so this is the same part
improved rather than a new one. If nothing was asked of you, send your part back unchanged: the
other players are revising around you and a part that moves under them undoes their work.

One call:
  space_ack {claimId: "{{claimId}}", resultKind: "phrase", resultBody: {
    song: "<the song id>", instrument: "<your instrument>", round: <the round in the record>,
    phrase: "<your bars>"
  }}

Every bar still has to add up. If any note asks you to fix the NOTATION, your last part was refused
before anyone heard it: call `space_kinds {kind: "phrase"}` and rewrite every bar to that format,
not just the ones an ask happened to name.

Stop with one line saying what you changed, or that you changed nothing and why.
