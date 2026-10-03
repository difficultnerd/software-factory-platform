#!/usr/bin/env python3
"""Fail if code writes sensitive content to durable storage.

Greps source for persistence calls near forbidden content fields. This is a
tripwire, not proof; pair it with review. Edit FORBIDDEN and SINKS for your domain.
"""
import re
import subprocess
import sys

FORBIDDEN = r"(email_body|email_content|message_body|raw_message|mail_text)"
SINKS = r"(INSERT\s+INTO|\.save\(|fs::write|File::create|shared_preferences|setString|sqflite|hive)"


def main() -> int:
    files = subprocess.run(
        ["git", "ls-files", "backend/src", "frontend/lib"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    hits = []
    for path in files:
        if not path.endswith((".rs", ".dart", ".sql")):
            continue
        with open(path, errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                if re.search(FORBIDDEN, line, re.I) and re.search(SINKS, line, re.I):
                    hits.append(f"{path}:{n}: {line.strip()}")
    print("\n".join(hits) or "no retention violations found")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
