#!/usr/bin/env python3
"""Dart licence gate (cargo-deny equivalent). Run after `flutter pub get`.

Reads .dart_tool/package_config.json, classifies each dependency's LICENSE file
by text, and fails on anything outside the allowlist or anything unrecognised.
Usage: check_dart_licenses.py [frontend-dir]
"""
import json
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

# (marker substring, SPDX-ish id). Checked in order, case-insensitive.
SIGNATURES = [
    ("gnu affero general public", "AGPL"),
    ("gnu lesser general public", "LGPL"),
    ("gnu general public license", "GPL"),
    ("mozilla public license", "MPL-2.0"),
    ("apache license", "Apache-2.0"),
    ("permission is hereby granted, free of charge", "MIT"),
    ("neither the name of", "BSD-3-Clause"),
    ("redistributions in binary form", "BSD-2-Clause"),
]
ALLOWED = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0"}
LICENSE_NAMES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "LICENCE")


def classify(text: str) -> str:
    low = " ".join(text.lower().split())
    for marker, spdx in SIGNATURES:
        if marker in low:
            return spdx
    return "UNKNOWN"


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "frontend")
    cfg = root / ".dart_tool" / "package_config.json"
    if not cfg.exists():
        print(f"{cfg} missing; run `flutter pub get` first")
        return 2
    failures = []
    for pkg in json.loads(cfg.read_text())["packages"]:
        if pkg["name"] == "app":
            continue
        uri = urlparse(pkg["rootUri"])
        base = Path(unquote(uri.path)) if uri.scheme == "file" else (cfg.parent / pkg["rootUri"]).resolve()
        lic = next((base / n for n in LICENSE_NAMES if (base / n).exists()), None)
        spdx = classify(lic.read_text(errors="replace")) if lic else "MISSING"
        status = "ok" if spdx in ALLOWED else "FAIL"
        print(f"{status:4} {pkg['name']:40} {spdx}")
        if status == "FAIL":
            failures.append(pkg["name"])
    if failures:
        print(f"\nDisallowed or unrecognised licences: {', '.join(failures)}")
        print("Review manually; extend ALLOWED only after a deliberate decision.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
