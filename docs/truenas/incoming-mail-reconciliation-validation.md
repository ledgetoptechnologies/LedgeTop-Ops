# Incoming notification duplicate-prevention validation

September 28, 2026. Local-only repair on the existing PR117 branch,
starting from `af938097cf0b789712e4af3e45c5b96fc77d6f41`.

## Reproduced failure

The joined test uses the real notification processor and SMTP adapter,
synthetic sockets, and isolated Miniflare D1 databases. Before this repair,
a final SMTP DATA 250 followed by failure to persist the sent receipt left
the digest retryable and sent a duplicate on its next attempt.

## Repair and recovery contract

- Persist an exact-attempt marker in the existing error-code field before
  transport; require successful current-attempt, unmarked, live-lease CAS.
- Pin claim selection and readback so a stale worker cannot adopt a newer
  attempt or overwrite its marker/state.
- Hold uncertain acceptance and accepted-but-unrecorded sends as failed with
  `mail-delivery-uncertain-reconciliation-required`; do not blindly retry.
- If recording that hold also fails, retain the durable marker. Expired
  marked attempts are held without sending, including attempt three.
- Expired unmarked attempts consume the next attempt on reclaim; an expired
  unmarked third attempt fails without another send.
- Invalid transport configuration and definite pre-DATA rejection remain
  bounded retries. Transport preflight performs no send.

This intentionally favors at-most-once automated sending. A crash after
persisting the marker but before transport can require operator review even
if nothing was sent. The SMTP Message-ID is stable, but is not a guarantee
of provider deduplication or inbox delivery. Historical unmarked attempts
cannot retrospectively prove whether a provider accepted a message.

## Evidence

- Implementer: three focused files, 27/27 tests, exit zero, 48.23 seconds;
  TypeScript check exit zero.
- Independent GPT-5.6 QA: same three files, 27/27, exit zero, 48.09 seconds;
  no material source-review finding.
- Orchestrator: joined and processor suites 19/19, exit zero, 48.11 seconds;
  exact `mailer-smtp-acceptance.test.ts` suite 8/8, exit zero, 166 ms.
- Runtime SHA-256 before commit:
  `EF84BEC096EE428311FACB9F7C6A194A042003A04FCA940EA6E0FBBAEF7B4F15`.
- Joined test SHA-256:
  `8B40BAEB3BAAB5D56DA35681A1836A9EB39F8C0F94B27BDD76D0C9AC63B9083D`.
- `git diff --check` passed; only normal Windows line-ending advisories.

Focused command, from `apps/operations`:

```text
npm exec -- vitest run --config vitest.config.ts test/incoming-upload-notification-smtp-joined.test.ts test/incoming-upload-notifications.test.ts test/mailer-smtp-acceptance.test.ts
```

No provider send, secret access, schema/configuration change, production
deployment, digest reset/resend, retention change or public-link change was
performed. Actual owner inbox delivery and any operator reconciliation UI
remain separate acceptance work; these tests do not prove either.
