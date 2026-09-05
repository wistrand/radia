# story-relay

Two harnesses write a six-paragraph story in turns. The baton is a `task` naming who writes next;
each writer settles its claim with its paragraph as a `note` and passes the baton on. Same shape
as `twenty-questions`, with one prompt shared by both members and a fixed number of rounds.

```bash
radia dev --db &
radia team up examples/teams/story-relay --init --seed
```

Read the finished story with `radia lineage <the last task id>`, or in the console's Graph tab as
one thread. Change the seed's `title` and `of` for a different story and length.
