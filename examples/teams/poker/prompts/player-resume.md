Next turn at the same table, record {{recordId}}:

{{body}}

Look up what you hold now rather than reusing the last hand you saw:

  space_read_one {kind: "poker_hole", match: {handId: "<the handId above>"}}

Then answer in the same turn:

  space_ack {claimId: "{{claimId}}", resultKind: "poker_action", resultBody: {
    session: "<the session above>", handId: "<the handId above>", street: "<the street above>",
    type: "<fold | check | call | bet | raise>", amount: <0, toCall, or toCall + betSize>
  }}

Check only when `toCall` is 0, raise only while `canRaise` is true. You have the earlier hands in
context, so use them: who has been raising, who folds to pressure, what your stack has done.
Always answer; never hand the turn back unplayed. Stop with one line saying what you did.
