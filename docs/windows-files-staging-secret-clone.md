# Offline comparison of a staging secret-only candidate

`compareWindowsStagingSecretClone` in
`scripts/windows-files-staging-secret-clone.mjs` is a pure operator supporting
tool. It does not read files, open credentials, call Cloudflare, provision keys,
approve Engineering Hub work or activate a version.

Inputs are one staging app at a time:

```js
{
  app: "operations", // or "delivery"
  accountId, workerName, baselineVersionId, candidateVersionId,
  plannedSecretNames,
  baseline: { version, modern },
  candidate: { version, modern }
}
```

`version` is the returned script-version resource object; `modern` is the
returned Worker version with `include=modules`. The IDs must be distinct valid
UUIDs and match both responses. Account/Worker identities are restricted to the
existing staging inventory. These caller-supplied labels do not independently
prove physical ownership, freshness or how the responses were obtained.

The plan must name exactly the three Operations or one Client dedicated Windows
secret slots from the existing shared constant, all previously absent. Every old
binding and keyed `modern.env` entry must match in full, including unknown policy
fields. Only exact new `secret_text` name/type bindings and corresponding
`{type:"secret_text"}` environment entries are admitted. Values are neither
required nor accepted for new secret records. There is no permission to rotate,
replace or remove an old key or plain variable.

The 128-variable budget counts plain, JSON, secret-text and secret-key entries.
Baseline plus all additions must fit. The observed Operations shape of 126 old
variables plus three new keys therefore refuses with the redacted error
`windows_staging_secret_clone_environment_budget_exceeded`. This tool does not
remove obsolete variables or change the key design to get around the limit.

Every returned module's bytes, name, type, array position and main-module
selection must remain identical. Base64 is validated canonically, with finite
module/count/byte bounds. Complete runtime/export/container/limit policy and the
entire returned modern `assets` object must match. Unknown resource fields are
not discarded: unsupported resource envelopes refuse and unknown policy fields
inside admitted resource objects remain part of exact comparisons.
Both captures must actually contain modern `assets.config` and runtime `assets`
objects. Two incomplete captures with missing or null asset metadata refuse.

Provider envelope provenance is handled separately: version ID/number/metadata,
modern startup time/annotations/URLs/source/author/time, and the script's
`last_deployed_from` may change without being mistaken for runtime policy.
The code etag, handler metadata and every other admitted state field remain
pinned. Paired endpoint version numbers and duplicated runtime policy must agree.
The provider's URL envelope is a bounded array, including an empty array; its
entries remain opaque envelope data rather than invented runtime policy.

The API's modern assets response currently exposes configuration only. A match
returns `returnedAssetsMetadataEqual:true` and explicitly
`opaqueAssetAssociationVerified:false`. It does not prove hidden asset-set
identity, a physical installation, approval, current head state or activation.
All authorization/freshness/physical-verification flags remain false. A separate
authorized release procedure must establish those properties.

Inputs may contain private plain-variable values. Do not commit or print them.
The comparator returns only IDs/counts/booleans; generic errors do not echo input.

Focused verification:

```powershell
node --test scripts/windows-files-staging-secret-clone.test.mjs
```
