"""Refresh a primary runtime manifest from the interpreter's installed distributions."""

from __future__ import annotations

import importlib.metadata
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: record-runtime-extras.py <runtime.json>")
    path = Path(sys.argv[1])
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise SystemExit("runtime manifest must be a JSON object")
    packages: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        version = distribution.version
        if name and version:
            packages[name] = version
    manifest["pythonPackages"] = dict(sorted(packages.items(), key=lambda item: item[0].lower()))
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
