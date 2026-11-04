# Production staff sign-in schema 0226

This one-shot procedure initializes the staff sign-in-link schema on the fixed Ledge Top Operations production D1 database. It inserts only the `staff_login_binding_control` seed row. It creates no staff record or email binding, and it does not change staff roles or enable native staff access.

Do not run this procedure until the production operator PR is merged to `main`, reviewed, and the immediate pre-run snapshot matches the pinned profile. The program refuses non-main branches, dirty working trees, a different account/database, schema or ledger drift, and any existing journal. Its `--apply` mode displays a fresh preflight summary and requires the exact interactive confirmation `APPLY 0226`; it then takes another immediate prewrite snapshot before issuing one D1 REST batch. It never retries an uncertain write.

## Credential and local preparation

Use a temporary Cloudflare API token for account `846c924bf17bf4f3dd15c97a4c5d1d51` with only the D1 permissions required to read the fixed database and apply the pinned migration. The previously issued Access Groups-read token is not sufficient. Do not put the token in a file, command-line argument, journal, or transcript.

Use a clean checkout on `main` after merge. Node.js with `node:sqlite` support is required. Create a protected local journal directory before running apply; keep the journal after any result, especially if the process reports an unknown outcome.

## Read-only check

At the repository root, run:

```powershell
node scripts/production-ops-staff-login-0226-run.mjs --check
```

This verifies the actual D1 database identity and reads the profile snapshot. It reports only the target, commit, plan digest, ledger/schema counts and hashes. It performs no writes. A mismatch is a stop condition; do not edit the baseline to make the check pass.

## One-time apply

Set `CLOUDFLARE_API_TOKEN` in the same PowerShell process without placing the secret in shell history. One way is to read it as a secure prompt, convert it only in process memory, and clear it afterwards:

```powershell
$secureToken = Read-Host 'Temporary Cloudflare D1 token' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    node scripts/production-ops-staff-login-0226-run.mjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Read-only preflight failed; stop.' }
    $journalDirectory = Join-Path $env:LOCALAPPDATA 'LedgeTop\Operations\migration-audit'
    New-Item -ItemType Directory -Force -Path $journalDirectory | Out-Null
    $journal = Join-Path $journalDirectory 'production-0226-once.jsonl'
    node scripts/production-ops-staff-login-0226-run.mjs --apply --journal $journal
    if ($LASTEXITCODE -ne 0) { throw 'Apply did not report verified success. Keep the journal and reconcile read-only; do not retry.' }
} finally {
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
```

The `--apply` run repeats target verification and preflight in a fresh process, prints the non-sensitive plan summary, and waits for the exact confirmation. Do not confirm if any target or baseline value differs. The final receipt must show one mutation call, ledger 226, 23 added schema objects, one seeded **control** row, zero generations/intents/bindings/audit rows, and zero alias rows.

## After the run

Retain the one-shot journal and release receipt. Independently reconcile the production ledger and the five `staff_login_*` tables with read-only queries. Then verify the account page can read its email-list endpoint. Linking the Technologies email is a separate verified sign-in flow; this migration does not bind it. If the request result is missing, partial, or uncertain, use read-only reconciliation and never replay the journal or batch.
