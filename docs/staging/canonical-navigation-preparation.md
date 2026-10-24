# Canonical navigation preparation

This isolated preparation candidate contains a pure navigation policy and ten tests only. It is disabled by default and has no application mount or live deployment. It is split from PR #239 so that the portal backend rollout can preserve its locked browser fingerprint and opaque historical assets.

Targets are `https://ops.ledgetop.app` for staff and `https://portal.ledgetop.app` for clients. Public bearer links, API methods, machine ingress, cookies, capabilities, uploads and Viewer routes stay on their existing origins. Future mounting requires a separately tested retained-asset UI release and live new-host authentication acceptance.

Validation: `node --test scripts/canonical-domain-navigation.test.mjs` (10 passed). The source-invariants CI job explicitly runs this test file; trigger policy and production settings are unchanged.
