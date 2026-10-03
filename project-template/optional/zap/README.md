# Layer: OWASP ZAP DAST

Use for repos with a live web login flow or API. Passive baseline scan against a staging URL.

1. `scripts/enable-layer.sh zap`
2. Set repo variable `ZAP_TARGET_URL` (Settings, Variables).
3. For authenticated scanning, add a ZAP context/auth script under `.zap/` (see ZAP docs on the automation framework).
4. Optional: add `zap-baseline` to the required checks in `.github/branch-protection.json`. It needs a reachable target, so most repos keep it scheduled rather than blocking.

Only scan systems you own. Active scans can modify data; keep them to disposable staging.
