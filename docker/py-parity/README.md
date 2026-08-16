# Python parity environment

The SDK content-key parity contract (`conformance/py-parity.test.ts`) skips wherever `python3` is
missing, so a green run on an arbitrary machine can mean "not checked". This container pins the
interpreter beside a pinned Deno and runs the suite against it: the same posture CI has (its
runners ship python3), with the versions made explicit and the skip made impossible.

    ./docker/py-parity/run.sh          # python 3.9 (oldest the SDK claims) and 3.13
    ./docker/py-parity/run.sh 3.11     # any python:<version>-slim tag

Or `deno task py-parity`. The repo mounts read-only; nothing is installed on the host. A
deployment recipe like `docker/keycloak/`, not an example.
