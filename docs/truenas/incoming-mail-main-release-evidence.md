# Incoming notification retry reliability — main-based release

Validated September 28, 2026 against Ops main `aef94236e88f8c61992a92c4ed40a0ccca0cd2bc`.

## Scope

- Independent transplant of the notification processor and focused tests from reviewed `18ed16a`, excluding stacked portal/profile work and then correcting legacy-attempt recovery.
- Existing SMTP adapter, authorization, database schemas, credentials, provider settings, retention, upload paths and public links are unchanged.
- Every send requires the existing active recipient and `file_requests.view` authority, a current claimed attempt and a durable exact-attempt marker.
- Accepted or acceptance-ambiguous sends are held for reconciliation, not automatically repeated. Receipt-persistence failure retains the same protection.
- All expired processing attempts are held, including old unmarked attempts: the old worker might already have sent before recording its result. This can hold an unsent message after a crash; it deliberately does not invent proof of non-delivery.
- Definite pre-DATA rejection and non-sending transport-preflight failures retain bounded retries. Existing terminal failures are not reset or resent.

## Local evidence

- `npm exec -- vitest run --config vitest.config.ts test/incoming-upload-notification-smtp-joined.test.ts test/incoming-upload-notifications.test.ts test/mailer-smtp-acceptance.test.ts`: three suites, 28 tests passed; terminal session `36651`, exit 0.
- `npm run check` in Operations: exit 0.
- `git diff --check`: passed.
- Independent QA found the legacy unmarked resend risk; the corrected implementation holds those attempts. Added direct cases for attempt counts 1–3, legacy non-marker errors and a competing lease renewal that prevents the hold CAS from changing the current row.
- Test SMTP sockets are synthetic. D1 behavior uses local Miniflare fixtures; no real email or production mutation was performed.
- Existing lockfile dependencies were restored without upgrades or bypassing blocked installation-script policy. Current Workers D1 type definitions were separately inspected at `@cloudflare/workers-types@5.20260928.1`; repository dependency versions were not changed.

## Release and operational gates

- Publish this isolated main-based change for exact-head CI; do not merge stacked PR 117 and its unrelated unreleased portal dependencies.
- A passing synthetic SMTP test is not provider delivery or inbox evidence. The owner's missing upload email remains unverified until current sanitized digest status and provider outcome are inspected.
- Do not automatically retry a reconciliation-held digest or reset the historical failed digest. An authorized operator must establish the outcome first; SMTP Message-ID alone does not prove delivery.
- No recipient enrollment, new portal access, PA production update, secret change or public-link change is included.
