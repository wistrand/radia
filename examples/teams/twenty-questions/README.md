# twenty-questions

Two harnesses play twenty questions through a space. Codex keeps a secret animal, Claude Code
guesses it with yes/no questions, and every move is a `task` for the other player. Neither is a
session: each is a WORKER (`radia team up`) that launches its harness only when a move is claimed
for it, so the game costs one launch per move and nothing while it waits.

```bash
radia dev --db &                                      # a space whose records outlive the process
radia team up examples/teams/twenty-questions --init --seed
```

`--init` mints the two members on this machine (once), `--seed` writes the opening task, and the
workers run until Ctrl-C. Watch the moves as arrows in `radia activity --follow` or the console's
Activity tab. Read the finished game with `radia lineage <the final note id>`, which walks the
questions (every task is parented on the one before), and `radia children <task id>` for the
answer acked on each; the console's Graph tab shows both as one thread.

The rules live entirely in `prompts/`, in the game's words: the launcher's frame supplies the
mechanics (which record, which claim, which calls). `tags` is the routing field: the guesser claims tasks
tagged `guesser`, the keeper those tagged `keeper`, and the turn changes hands by each player
writing the next task for the other. The `final` tag ends it. Copy this directory and change the
prompts to make a different game; the runtime learns nothing about any of them.

A launched harness remembers nothing between moves: the space is its memory for everything the
other player may see, and its own directory (`~/.radia/team/<member>/`) for what must not be,
which is where the keeper writes its secret.

Tuning: run one member with `--once` to test its prompt on a single move. A player that forgets to
hand the turn over stops the game with its last note and nothing stuck; `radia put task
'{"team":"twenty-questions","title":"your move","tags":["guesser"],"move":3}'` restarts it by hand.
