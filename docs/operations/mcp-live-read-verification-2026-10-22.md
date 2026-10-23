# Operations MCP live read verification — 2026-10-22

## Verified connection

The installed `ledgetop_operations` server is a **local stdio MCP adapter**.
Its HTTPS API origin is `https://ops.ledgetopdroneservices.com`; this is not a
remote HTTP MCP endpoint. The new `ops.ledgetop.app` origin was not substituted.

The existing explicit `login` command used cloudflared 2026.10.3 with SHA-256
`76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`
and valid Cloudflare Authenticode signature. Quiet subprocess capture excluded
credential output. Existing browser SSO completed without a new PIN.
No credential/cache file was opened or copied.

After login, both `doctor` and the **already installed MCP tool**
`get_connection` succeeded as the active owner administrator, with local writes
disabled. A bounded installed-tool search for the previously approved synthetic
“Production owner onboarding notification acceptance” client returned its two
source-qualified records. `get_client` then succeeded using the exact primary
source, namespace, route kind, and public ID returned by that search. No real
client changes, grants, emails, financial operations, or link creation occurred.

The separate staging machine adapter independently connected in read-only mode
with no visible sources. It was not used to replace or bypass human access.

## Added capability and local tests

The isolated adapter patch adds `get_existing_public_link(prefix, itemRef?)`
over the existing authorized `GET /api/delivery/shares/active` API. It does not
change the backend, credential model, scopes, or local write gate. The server
requires the same sharing permission as the UI before recovering an existing
bearer URL. Null/denial never creates a replacement link.

All 34 adapter tests and syntax checks pass, including actual SDK child-process
stdio discovery of ten read tools, exact encoded query routing, rejected extra
arguments, and null/403 behavior with no mutation/fallback. These tests use
synthetic API fixtures. **The added link lookup has not been verified against
a live synthetic share.** Its installed discovery and authenticated transport
were verified separately below.

A separately launched actual SDK stdio client against the isolated patched
adapter discovered ten tools (including the new lookup), then completed live
`get_connection` as the same active owner with writes disabled. This verifies
the patched transport/authentication path without changing the installed adapter.

Subsequent activation applied only the reviewed MCP tool/tests and human README
to the clean installed adapter based on `b20ff708`; final installed commit is
`e89d102b`. No Windows branch, machine-mode implementation, backend, or auth
changes were imported. The installed human-only baseline passes all 21 of its
tests and syntax checks; the integration worktree passes all 34 including its
separate machine tests. Fresh installed SDK subprocesses for diagnostic labels
`codex`, `claude`, and `hermes` each discovered ten tools and completed live
`get_connection` as the active owner with writes disabled. The new link lookup
itself still has no live synthetic-share receipt, and no real bearer URL was read.

Claude Code's supported user configuration now contains the human adapter and
its CLI reports Connected. Local Hermes saved all ten read tools and its actual
`mcp test` reports Connected/ten tools. Both pre-existing staging entries were
preserved. No running Codex/Claude process was forcibly reloaded; a previously
connected process may continue to advertise its original nine tools.

## Client support and remaining boundaries

The README supplies local stdio configurations for Codex, Claude, and Hermes.
Each runtime must be able to execute Node and this adapter, reach the Ops HTTPS
origin, and hold its own permitted human cloudflared session. The agent label is
diagnostic, not a separately delegated server identity.

This verification establishes the installed Codex connection, fresh subprocess
connections, and Claude/Hermes CLI setup. It does not establish tool invocation
from an already running Claude or Hermes conversation.
A Hermes runtime on another host cannot use this PC's script path or Access
cache; it needs its own supported local setup and authorized login. Hosted
clients require a separately reviewed remote transport/authentication design.
No remote HTTP MCP endpoint, browser WebMCP integration, unattended human login,
or production write capability was added or claimed.
