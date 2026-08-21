# Python parity environment

This container runs the SDK content-key parity contract against explicit Python and Deno versions.
It prevents `test/py-parity.test.ts` from skipping when the host lacks Python.

    ./docker/py-parity/run.sh          # python 3.9 (oldest the SDK claims) and 3.13
    ./docker/py-parity/run.sh 3.11     # any python:<version>-slim tag

Or `deno task test:py-parity`. The repo mounts read-only; nothing is installed on the host. A
deployment recipe like `docker/keycloak/`, not an example.
