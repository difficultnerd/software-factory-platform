# Project template

Rust backend, Flutter front end (iOS, Android, web). Python only for tooling in `tools/` and `scripts/`. Free and open source tooling only.

## Core toolchain

| Concern | Tool | Local | CI |
|---|---|---|---|
| Secret scanning | Gitleaks | pre-commit | every push and PR, full history |
| Dependency updates | Dependabot (cargo, pub, actions, pre-commit) | n/a | weekly PRs |
| Rust advisories | cargo-audit | n/a | CI plus weekly schedule |
| Static analysis | Clippy, Dart analyzer, Semgrep | clippy and analyze on pre-push | CI |
| Format | rustfmt, dart format | pre-commit | CI |
| Licences | cargo-deny (Rust), `tools/check_dart_licenses.py` (Dart) | n/a | CI |
| Branch protection | `scripts/apply-branch-protection.sh` | n/a | requires `ci-gate` |

Commit signing is not part of the core.

## Use

1. Create a repo from this template (copy the contents of this directory to the repo root if you are extracting it from a monorepo).
2. Generate Flutter platform folders: `cd frontend && flutter create . --platforms=ios,android,web --project-name app`, then commit the result and `pubspec.lock`.
3. `pip install pre-commit && pre-commit install`
4. Push to `main`, let CI run once so the `ci-gate` check exists, then `scripts/apply-branch-protection.sh`.
5. In Settings, Code security, enable Dependabot alerts and security updates. Tick "Template repository" if this is the template itself.

Branch protection on private repos needs a paid GitHub plan. On the free plan, keep the repo public or the protection call will fail.

## Branch protection

`.github/branch-protection.json` requires the single `ci-gate` check (which fails unless every job in `ci.yml` passed), requires the branch to be up to date, applies to admins, blocks force pushes and deletions, and requires linear history. It requires no approving reviews, which suits a solo repo; set `required_pull_request_reviews` if that changes. When you add a job, add it to `ci-gate`'s `needs`.

## Optional layers (off by default)

Enable with `scripts/enable-layer.sh <name>`. Each layer's README sits in `optional/<name>/`.

- `zap`: OWASP ZAP baseline scan for web-facing login flows and APIs.
- `privacy`: log-leak Semgrep rules and a retention tripwire for no-data-retention commitments.
- `gpg-signing`: signed-commit enforcement for verified authorship.

Container and infrastructure scanning is out of scope for now.

## Known limits

- Pinned tool versions (Gitleaks 8.24.2, Semgrep 1.100.0, action tags) were written without network access to confirm they are current. Dependabot covers actions and pre-commit revs, not the two `env` versions in `ci.yml`; bump those by hand.
- The Dart licence checker classifies LICENSE text by keyword. It fails closed on anything unrecognised, so expect to review the odd package manually.
- Semgrep `p/default` and `p/security-audit` load from the registry at run time, which needs network but no account.
