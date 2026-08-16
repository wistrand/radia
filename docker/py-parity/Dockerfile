# A pinned python3 beside a pinned deno, so the SDK content-key parity contract
# (conformance/py-parity.test.ts) runs against a KNOWN interpreter instead of whatever the host
# happens to have. The suite skips wherever python3 is absent, which makes a green local run
# ambiguous; a run in here cannot silently skip.
#
# PY_VERSION defaults to 3.9 because that is the oldest the Python SDK claims to support
# (sdk/README.md). DENO_VERSION tracks the 2.x line CI installs.
ARG PY_VERSION=3.9
ARG DENO_VERSION=2.9.2

FROM denoland/deno:bin-${DENO_VERSION} AS deno

FROM python:${PY_VERSION}-slim
COPY --from=deno /deno /usr/local/bin/deno
# The repo mounts read-only at /repo, so the module cache lives in the container layer.
ENV DENO_DIR=/tmp/deno-cache
WORKDIR /repo
CMD ["deno", "test", "--frozen", "--allow-read", "--allow-run=python3", "conformance/py-parity.test.ts"]
