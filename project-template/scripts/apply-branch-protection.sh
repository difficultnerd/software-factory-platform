#!/usr/bin/env bash
# Apply branch protection to main. Needs the gh CLI, admin rights, and a public repo
# (or a paid plan for private repos). Usage: scripts/apply-branch-protection.sh [owner/repo]
set -euo pipefail
cd "$(dirname "$0")/.."
repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
gh api -X PUT "repos/${repo}/branches/main/protection" --input .github/branch-protection.json
echo "Protection applied to ${repo}:main"
