# Organization attachment access — local verification

Outcome: **fixed locally; not published or deployed**. This closes the scoped
attachment boundary, not the broader migration or production acceptance gates.

## Finding and preserved behavior

- PA's `src/controllers/serve_upload.php` formerly allowed any signed-in session
  to read an existing organization tax attachment, without checking organization
  permissions or whether the file was still the organization's current pointer.
  Best-effort cleanup could leave a replaced/removed file reachable by its URL.
- The invariant is current attachment identity plus current authorized user.
  PA organizations remain customer records under the existing global organization
  ACL; this patch does not invent customer-tenant membership semantics.
- Public root branding images remain public. Other authenticated upload categories
  retain their existing authentication behavior. This does not certify the
  unrelated document categories' authorization model.

## Candidate and review

PA changed files:

- `src/controllers/serve_upload.php`
- `src/services/OrganizationTaxDocumentAccessService.php` (new)
- `src/services/UploadPathService.php` (new)
- `tests/Security/OrganizationAttachmentBoundaryTest.php` (new)

The controller checks a live user/auth version, existing `organizations.view`
and record access, and an exact current database filename pointer. Database
collation cannot authorize a differently cased pointer. Protected responses use
`Cache-Control: private, no-store`; failed validation does not expose file content.
Path normalization and exact canonical resolution prevent child filesystem aliases
from turning public logos or another category into organization-document access.
The base volume itself may resolve through a symlink.

A fresh Sol investigation traced callers, runtime upload mounts and the Apache
public root. A separate fresh Terra candidate review found no authorization bypass,
but identified overbroad rejection of trailing-dot/space Linux filenames. That
restriction now applies only to Windows alias semantics; actual Linux legacy-file
download controls pass. The single independent review cycle is complete.

## Ordered verification

Verified local file SHA-256 identities (line-ending-sensitive):

```text
src/controllers/serve_upload.php 48079B1D6930162DD64964BED9C24ED5CFC1D9681205222D899DE8BA96570C8D
src/services/UploadPathService.php BCF7BCBC0667B72C656E0ECBAEFE630CA320B4812EB4DA9FF6DA8CA12A5FEE59
src/services/OrganizationTaxDocumentAccessService.php 31A2C94FAF2E9C048B49B37B17E0E36A32C7FDC0B5E6EF939C782380ACA6DD81
tests/Security/OrganizationAttachmentBoundaryTest.php 6DD373069666AAFF112EE6F6EB0125149EBE103AB270F0923332B9346FE6D6E0
```

1. Syntax and diff: `php -l` passed for the controller, both helpers and regression
   test; scoped `git diff --check` passed. The existing line-ending notice is not
   a whitespace failure.
2. Trigger and alternate input: the real controller in a disposable copied layout
   denies an existing orphan and removed-pointer file, serves the current pointer
   only with authorized identity, and applies the same gate to backslash inputs.
   Tests also cover disabled/deleted/revoked users, permission denial, exact pointer
   comparison, arrays/NUL/traversal, path aliases and symlink escape.
3. Legitimate controls: the same subprocess controller serves anonymous logo
   bytes and authenticated ordinary upload bytes; denies anonymous private upload;
   serves current authorized organization bytes; preserves Linux legacy filenames.
4. Full owning suite: Windows `C:\xampp\php\php.exe vendor/bin/phpunit
   --do-not-cache-result --colors=never` completed with **1,033 tests, 7,599
   assertions, 96 skips**, exit 0. Two added skips are platform limitations;
   the other 94 pre-existing optional/environment skips remain unverified by this run.
5. Linux focused command below completed with **16 tests, 93 assertions, zero
   skips**, exit 0. It executes the Windows-skipped symlink and Linux filename cases.

```powershell
docker run --rm --network none --read-only --cap-drop ALL `
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev `
  --mount 'type=bind,source=<PROJECT_ALPHA_CHECKOUT>,target=/app,readonly' `
  --workdir /app --entrypoint php project-alpha-no-reply-qa:latest `
  vendor/bin/phpunit --do-not-cache-result --colors=never `
  tests/Security/OrganizationAttachmentBoundaryTest.php
```

No production data, credentials, documents, public links, retention settings or
deployment configuration were changed. Tests use synthetic files and SQLite
fixtures; the container has no network and only disposable `/tmp` writes.
Staging/live browser attachment acceptance and the owner-reviewed PA release
remain outstanding. This report is not permission to deploy PA.
