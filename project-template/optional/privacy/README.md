# Layer: privacy by design

Use for repos that commit to no data retention. Adds:

- Semgrep rules flagging sensitive field names in log/print calls and `derive(Debug)` on sensitive structs (`.semgrep/privacy.yml`).
- A retention tripwire (`tools/check_retention.py`) flagging persistence calls on content fields.
- A `privacy` CI job.

Enable: `scripts/enable-layer.sh privacy`, then edit the field lists in both files to match your domain. Add `privacy` to the required checks and to the `ci-gate` needs if you want it blocking.

These are pattern checks. They catch careless logging; they will not catch data leaving through an indirect path. Back them with a data-flow review and tests that assert nothing is stored.
