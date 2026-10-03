#!/usr/bin/env python3
"""Fail if Python files exist outside tools/ and scripts/ (Python is for tooling only)."""
import subprocess
import sys

ALLOWED = ("tools/", "scripts/", "optional/")


def main() -> int:
    out = subprocess.run(
        ["git", "ls-files", "*.py"], capture_output=True, text=True, check=True
    ).stdout.split()
    bad = [f for f in out if not f.startswith(ALLOWED)]
    for f in bad:
        print(f"Python outside tools/ or scripts/: {f}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
