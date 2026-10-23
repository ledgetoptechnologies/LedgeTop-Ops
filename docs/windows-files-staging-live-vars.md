# Preserving staging variables before Windows source composition

`scripts/windows-files-staging-live-vars.mjs` is an optional pure preparation
step. It does not fetch configuration, read credentials or deploy anything.
Call `preserveWindowsStagingLiveVars({sources, preflight, versionDetails})` with
paired `operations` and `delivery` source objects, the existing staging
preflight, and paired version envelopes:

```js
versionDetails.operations = {
  accountId: stagingAccountId,
  workerName: observedWorkerName,
  detail: observedVersionDetail
};
```

The details must match the preflight's version IDs and the staging inventory's
account and Worker names. Runtime compatibility dates and ordered flag arrays
must match the source config exactly. A mismatch requires explicit review of the
source; the function never updates compatibility settings implicitly.

The returned source `vars` maps replace template variables with **all and only**
the observed `plain_text` variables, preserving string values byte for byte,
including empty values and `"false"`. Unknown current variables survive and
template-only extras disappear. Binding names must be unique uppercase names,
including across secret and non-secret types. Dedicated Windows key slots cannot
appear as plain variables. JSON and unrecognized binding types are rejected.
Limits are 1,000 bindings, 32 KiB per text value, and 1 MiB aggregate text per app.

`buildWindowsStagingCompositionWithLiveVars` feeds these preserved source objects
into the existing constructor without changing its checks or default behavior.
The existing enabled-profile overrides remain explicit; disabled preparation
does not turn on reader flags or require unapplied migration suffixes.

Only variables are preserved. This is not preservation of routes, cron, asset
settings, other binding resources or secrets, and establishes no authorization,
freshness or independent physical proof. Those require separate checks before
activation. A caller-supplied envelope is a consistency assertion, not a signed
server attestation. Preflight and version snapshots may also have raced.

Returned configs contain actual values and must stay private. The additional
receipt includes only app/Worker/version labels, variable counts and fixed
status booleans; it contains no variable values, names or per-variable hashes.
Errors are generic and do not echo supplied input. The original composition
receipt still contains its existing whole-config hashes and public metadata.
No raw captures belong in this repository.

Focused verification:

```powershell
node --test scripts/windows-files-staging-live-vars.test.mjs
```
