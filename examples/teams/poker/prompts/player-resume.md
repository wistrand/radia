Another turn at the same table, record {{recordId}}:

{{body}}

Same objective: the chips in front of you when the session ends.

Look up what you hold now rather than reusing what you saw last time, since a changed `handId`
means new cards:

  space_read_one {kind: "poker_hole", match: {handId: "<the handId above>"}}

Then answer in the same turn:

  space_ack {claimId: "{{claimId}}", resultKind: "poker_action", resultBody: {
    session: "<the session above>", handId: "<the handId above>", street: "<the street above>",
    type: "<your action>", amount: <0, toCall, or toCall + betSize>
  }}

You have the earlier hands in context. Use them: who has been raising, who folds to pressure,
who paid you off last time, and what your stack has done since you sat down. Always answer, and
never hand the turn back unplayed. Stop with one line saying what you did.
