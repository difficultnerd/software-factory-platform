#!/usr/bin/env bash
# Enable an optional layer: scripts/enable-layer.sh <zap|privacy|gpg-signing>
set -euo pipefail
cd "$(dirname "$0")/.."
layer="${1:?usage: enable-layer.sh <zap|privacy|gpg-signing>}"
src="optional/${layer}"
[ -d "$src" ] || { echo "unknown layer: $layer"; exit 1; }

mkdir -p .github/workflows
cp "$src"/.github/workflows/*.yml .github/workflows/

case "$layer" in
  zap)
    cp -r "$src/.zap" . ;;
  privacy)
    cp "$src/semgrep/privacy.yml" .semgrep/privacy.yml
    cp "$src/check_retention.py" tools/check_retention.py
    chmod +x tools/check_retention.py ;;
  gpg-signing)
    repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    gh api -X POST "repos/${repo}/branches/main/protection/required_signatures" \
      -H "Accept: application/vnd.github+json" >/dev/null
    echo "required_signatures enabled on ${repo}:main" ;;
esac
echo "Layer '$layer' enabled. Review the new files, then commit."
