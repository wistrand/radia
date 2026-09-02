#!/usr/bin/env python3
"""Build the radia-space wheel from the staged dist/pypi tree, stdlib only.

A pure wheel is a zip plus three metadata files, so building it here keeps the release path off
PyPI twice over: `pip install build` at release time would fetch the build backend from the
registry this distribution avoids, and an sdist would make every USER install fetch one too.
release.yml smoke-installs the result, so a RECORD mistake fails the release, not the install.

  python3 scripts/build-wheel.py <staging-dir> <out-dir>

Metadata comes from <staging-dir>/pyproject.toml by regex, not tomllib: the file is this repo's
own heredoc (scripts/build-release.sh), and the SDK's floor is 3.9, which has no tomllib.
"""
import base64
import hashlib
import re
import sys
import zipfile
from pathlib import Path


def die(msg):
    print(f"build-wheel: {msg}", file=sys.stderr)
    raise SystemExit(1)


def field(toml, key):
    m = re.search(rf'^{key} = "([^"]+)"$', toml, re.M)
    if not m:
        die(f"pyproject.toml has no `{key}`")
    return m.group(1)


def main():
    if len(sys.argv) != 3:
        die("usage: build-wheel.py <staging-dir> <out-dir>")
    staging, out = Path(sys.argv[1]), Path(sys.argv[2])
    toml = (staging / "pyproject.toml").read_text()
    name = field(toml, "name")
    version = field(toml, "version")
    pkg_m = re.search(r'^packages = \["([^"]+)"\]$', toml, re.M)
    if not pkg_m:
        die("pyproject.toml names no package")
    pkg = pkg_m.group(1)

    dist = name.replace("-", "_")
    info = f"{dist}-{version}.dist-info"
    entries = []
    for p in sorted((staging / pkg).glob("*.py")):
        entries.append((f"{pkg}/{p.name}", p.read_bytes()))
    if not entries:
        die(f"no *.py under {staging / pkg}")
    entries.append((f"{info}/licenses/LICENSE", (staging / "LICENSE").read_bytes()))
    metadata = (
        "Metadata-Version: 2.1\n"
        f"Name: {name}\n"
        f"Version: {version}\n"
        f"Summary: {field(toml, 'description')}\n"
        f"License: {field(toml, 'license')}\n"
        f"Requires-Python: {field(toml, 'requires-python')}\n"
    )
    entries.append((f"{info}/METADATA", metadata.encode()))
    entries.append((
        f"{info}/WHEEL",
        b"Wheel-Version: 1.0\nGenerator: radia build-wheel\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    ))

    record = []
    for path, data in entries:
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{info}/RECORD,,")
    entries.append((f"{info}/RECORD", ("\n".join(record) + "\n").encode()))

    out.mkdir(parents=True, exist_ok=True)
    wheel = out / f"{dist}-{version}-py3-none-any.whl"
    # A fixed timestamp keeps the zip byte-identical across rebuilds of one version, so a re-run
    # of the release job produces an asset whose sha256 matches the one already published.
    stamp = (1980, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as z:
        for path, data in entries:
            zi = zipfile.ZipInfo(path, date_time=stamp)
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
    print(wheel)


if __name__ == "__main__":
    main()
