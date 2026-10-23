# Windows staging: actual configuration preservation check

The independent code review of `725d54a5` found no actionable issue; its focused
suite passed 24/24. A separate operator check then used the privately captured
actual staging version responses, rather than test fixtures. The pure transform
preserved all 116 Ops and 93 portal plain-text variables exactly. Disabled
composition succeeded without changing those values or its input objects.
No actual values, credentials or per-variable hashes are included here.

| Application | Captured active version |
| --- | --- |
| Ops staging | `231fead7-433e-4015-847e-ea9ebda35894` |
| Portal staging | `6b9f1ff4-ce41-493e-a922-25081c2b67f4` |

The capture is an observation, not a freshness guarantee or deployment approval.
The receipt is tracked in Engineering Hub under
`windows-download/live-variable-preservation-actual-check-2026-10-23.md`.
Runtime compatibility dates and flags matched the checked source templates.
The observed plain variables replace template values completely: 13 current Ops
variables and six current portal variables would otherwise have been missing.

After the human approved publication, the existing staging tunnel gained only
`employee-gateway-staging.ledgetopdroneservices.com` with path `^/v1/read$`,
forwarding to `http://127.0.0.1:18089`. The two existing PA routes were retained.
The private gateway service contains only a generated 2 MiB file on local ext4.
Actual HTTPS requests with normal certificate validation established:

- Unsigned requests receive 401; a path outside the route receives 404.
- Signed manifest and full-content requests receive 200 with the expected size
  and SHA256.
- A signed range starting at byte 16,384 receives 206 and the exact remaining
  bytes.

These checks qualify the synthetic gateway transport, not a Windows app rollout.
No Ops file grant, database migration, Worker activation, production deployment
or TrueNAS access occurred. The Ops and portal Windows routes remain unmounted.
The actual desktop helper sign-in was separately checked; discovery currently
reaches the old workspace guard because the paired composition is not active.

Before activation, independently approve the exact candidate in EH, retain a
verified restorable staging checkpoint, apply only the five reviewed Windows
suffix migrations, preserve other resource bindings/assets, and provision the
separate signing/handle/queue keys through the protected operator path. Then
exercise actual desktop employee and authorized R2 downloads and revocation.
This follow-up does not replace the frozen PR250 candidate or claim EH execution.
