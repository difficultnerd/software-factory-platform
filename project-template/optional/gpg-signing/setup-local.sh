#!/usr/bin/env bash
# Configure git to sign commits with an existing GPG key. Usage: setup-local.sh <KEY_ID>
set -euo pipefail
key="${1:?usage: setup-local.sh <GPG_KEY_ID>}"
git config commit.gpgsign true
git config tag.gpgsign true
git config user.signingkey "$key"
echo "Signing enabled for this repo. Upload the public key (gpg --armor --export $key) to GitHub, Settings, SSH and GPG keys."
