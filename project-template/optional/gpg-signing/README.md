# Layer: GPG commit signing

Use where verified authorship is required.

1. `scripts/enable-layer.sh gpg-signing` copies the verify workflow and turns on `required_signatures` for main (needs admin).
2. Each contributor runs `optional/gpg-signing/setup-local.sh <KEY_ID>` and uploads their public key to GitHub.
3. Add `signatures` to the required checks if you want the workflow to block as well. Branch protection alone rejects unsigned pushes to main.

Squash merges made in the GitHub UI are signed by GitHub, so they pass.
