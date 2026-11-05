# Production auto-release journal recipient

The source-pinned RSA public key in `scripts/production-auto-private-recipient.mjs`
seals provider response bodies before they enter the private release artifact.
Its SPKI DER SHA-256 fingerprint is checked by the journal loader and the key
must be RSA-3072 or stronger. The public key is not a deployment credential.

The matching decryption key is held separately from this repository. This source
change does not provision workflow enablement, Cloudflare or GitHub credentials,
the recurring-release authority policy, a current preservation review, the
installed release profile, or CI/migration readiness. Those checks remain
independent prerequisites; the recipient pin alone does not make automatic
release operational or authorize a provider mutation.

Replacing this recipient requires a reviewed source change that updates the
public PEM and its matching SPKI fingerprint together. Never put the private
key or its custody material in source control, artifacts, or logs.
