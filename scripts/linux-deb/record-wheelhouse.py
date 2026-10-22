"""Print manifest records and a license table for one offline wheelhouse."""

from __future__ import annotations

import email
import hashlib
import re
import sys
import zipfile
from pathlib import Path

from packaging.utils import parse_wheel_filename


def wheel_metadata(wheel: Path) -> email.message.Message:
    with zipfile.ZipFile(wheel) as archive:
        metadata = next((name for name in archive.namelist() if name.endswith(".dist-info/METADATA")), None)
        if metadata is None:
            raise SystemExit(f"wheel has no METADATA: {wheel.name}")
        return email.message_from_bytes(archive.read(metadata))


def declared_license(metadata: email.message.Message) -> str:
    expression = metadata.get("License-Expression")
    if expression:
        return str(expression)
    license_text = metadata.get("License")
    if license_text:
        return str(license_text).splitlines()[0][:200]
    classifiers = metadata.get_all("Classifier") or []
    declared = [value.removeprefix("License :: ") for value in classifiers if value.startswith("License :: ")]
    return "; ".join(declared) if declared else "UNKNOWN"


def main() -> int:
    if len(sys.argv) not in (2, 4) or (len(sys.argv) == 4 and sys.argv[2] != "--notices"):
        raise SystemExit("usage: record-wheelhouse.py <wheelhouse> [--notices <path>]")
    root = Path(sys.argv[1])
    notices = Path(sys.argv[3]) if len(sys.argv) == 4 else None
    rows: list[tuple[str, str, str]] = []
    for wheel in sorted(root.glob("*.whl")):
        name, version, _build, _tags = parse_wheel_filename(wheel.name)
        metadata = wheel_metadata(wheel)
        license_text = declared_license(metadata)
        if re.search(r"\b(?:A?GPL)\b", license_text, re.IGNORECASE):
            raise SystemExit(f"wheelhouse contains GPL/AGPL terms: {wheel.name} ({license_text})")
        rows.append((name, str(version), license_text))
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        print(
            "\t".join(
                (
                    "archive",
                    name,
                    str(version),
                    f"wheelhouse/{wheel.name}",
                    f"sha256:{digest}",
                    "Python library inside the shipped wheelhouse",
                    "1",
                )
            )
        )
    if notices is not None:
        notices.parent.mkdir(parents=True, exist_ok=True)
        rows_markdown = "".join(
            f"| `{name}` | {version} | {license_text.replace('|', chr(92) + '|')} |\n"
            for name, version, license_text in rows
        )
        notices.write_text(
            "# Python wheelhouse notices\n\n"
            "Generated from each wheel's distribution metadata. Review the full license and notice files "
            "inside the corresponding wheel before redistribution.\n\n"
            "| Package | Version | Declared license |\n"
            "| --- | --- | --- |\n"
            + rows_markdown,
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
