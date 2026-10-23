# Additive UI release candidate

This private static-only Worker is a proposed deployment resource. Its configuration
has no routes, workers.dev endpoint, preview URL, data binding, API, or secrets.
Nothing in this directory activates a production binding or HTML selector.

Operations and Client have optional `UI_RELEASE_ASSETS` HTTP service bindings and
`UI_ACTIVE_RELEASE` selectors. An absent or empty selector retains their original
HTML. Registered immutable assets remain available independently of the selector,
so an HTML rollback can continue serving files needed by already-open new tabs.
Application origin, API, native owner, and public share admission remain with each
application. Existing public share shells continue using their original assets.

The catalog contains the independently reproduced, prefixed UI builds from commit
`cfcf5cf992084f7b3658763cdf362fbc37101665`: 237 Operations files and 21 Client files,
including source maps and unreferenced icons. The only omitted file is each build's
`.assetsignore` upload control file; the packet receipt records its exact bytes.
Catalog SHA256 values describe local files. Runtime transfer checks MIME and byte
count; it does not authenticate a live namespace by hashing every response.

Create an offline packet in a new directory:

```sh
node scripts/ui-release-packet.mjs /path/to/independent-prefixed-build-proof /new/packet
```

The command checks both complete build trees against pinned manifest digests and
each other before writing. It does not deploy, authorize the inventory, qualify a
production provider runtime, or modify a primary asset collection. The local native
runtime test can then use `UI_RELEASE_PACKET_ROOT=/new/packet` and
`UI_RELEASE_FIXTURE_DEPENDENCY_ROOT=/path/to/operations/node_modules` with
`node --test scripts/ui-release-packet-local.test.mjs`.

Before deployment, a separate reviewed release packet must qualify the intended
compatibility date, exact provider upload and namespace bytes, private resource
reachability, primary `keep_assets` preservation, binding configuration, finite
presentation paths in `run_worker_first`, active profile/guard changes, browser
CSP and deep navigation, and HTML rollback with both generations open. The current
production guard intentionally rejects UI-mode deployment and is unchanged here.
Do not deploy this candidate using the backend-only release path.

The full-file local test passed on the locked workerd runtime at compatibility
date `2026-08-06`. It also passed on the matching Wrangler `4.152.0`, Miniflare
`5.20261019.2-beta`, workerd `1.20261019.1` toolchain at the intended date
`2026-10-23`, including HEAD and negative path/credential checks. Set
`UI_RELEASE_FIXTURE_COMPATIBILITY_DATE` explicitly for that qualification.
The newer harness uses its exported V4-options converter for this single Worker;
mixing an older harness with a newer binary is rejected. These checks qualify the
local private Worker only; provider and browser acceptance remain outstanding.
Native LTDS project creation, Viewer grants, and sharing flags remain separate.
