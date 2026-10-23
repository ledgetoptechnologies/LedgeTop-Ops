# Local agent setup — Operations MCP

This is an authenticated **stdio MCP** connection to the existing Operations API.
Agents use its fixed tools without editing repository source. There is currently
no remote HTTP MCP URL or browser WebMCP endpoint.

## Verified PC paths

- Node: `C:/Program Files/nodejs/node.exe`
- Installed adapter: `C:/Projects/Ledge Top Operations/operations-private-mcp/apps/operations-mcp/src/cli.mjs`
- Qualified cloudflared: `C:/Users/fstor/.codex/cache/windows-package-inputs-cloudflared-2026.10.3/cloudflared.exe`
- API origin: `https://ops.ledgetopdroneservices.com`
- cloudflared SHA-256: `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`

cloudflared has a valid Cloudflare Authenticode signature. These paths identify
installed executable code, not credential files. No token belongs in MCP config.
On another host, replace executable/script paths with its verified local paths.

## Explicit human login

Run this in PowerShell on the machine and OS account running the adapter:

```powershell
$env:LTDS_CLOUDFLARED_PATH='C:/Users/fstor/.codex/cache/windows-package-inputs-cloudflared-2026.10.3/cloudflared.exe'
$env:LTDS_OPS_ORIGIN='https://ops.ledgetopdroneservices.com'
node 'C:/Projects/Ledge Top Operations/operations-private-mcp/apps/operations-mcp/src/cli.mjs' login
node 'C:/Projects/Ledge Top Operations/operations-private-mcp/apps/operations-mcp/src/cli.mjs' doctor
```

Normal Cloudflare browser sign-in may require the human's PIN/passkey. The
adapter captures credential output privately; tools never automatically start
login. Sessions expire according to the existing Access policy. Do not copy
another account's cache or use the staging machine identity as a fallback.

## Codex

The existing `ledgetop_operations` entry is enabled and live reads were verified.
Do not create a duplicate. Its nonsecret settings can be inspected with the
supported `codex mcp get ledgetop_operations --json` command, selecting only
command, arguments, origin and helper path before displaying anything.

## Claude Code

The following user-scoped entry was added through Claude's supported CLI. The
existing `ledgetop_operations_staging_read` entry was retained. The installed
Claude CLI reports this human stdio entry **Connected**.

```powershell
claude mcp add ledgetop_operations --scope user --transport stdio `
  -e 'LTDS_OPS_ORIGIN=https://ops.ledgetopdroneservices.com' `
  -e 'LTDS_MCP_AGENT_ID=claude' -e 'LTDS_MCP_ALLOW_WRITES=false' `
  -e 'LTDS_CLOUDFLARED_PATH=C:/Users/fstor/.codex/cache/windows-package-inputs-cloudflared-2026.10.3/cloudflared.exe' `
  -- 'C:/Program Files/nodejs/node.exe' `
  'C:/Projects/Ledge Top Operations/operations-private-mcp/apps/operations-mcp/src/cli.mjs'
```

This verifies Claude Code configuration/connection, not a tool invocation from
an already running Claude chat. A running chat may need its supported MCP
reconnection or a new session before discovering the added server.

## Hermes

The installed local Hermes CLI supports this equivalent configuration command
(`--args` must be last). The server name must not replace the staging entry.
This entry was added and saved with all ten read tools enabled; the existing
staging entry remains present. Actual `hermes mcp test` passed with ten tools.

```powershell
hermes mcp add ledgetop_operations `
  --command 'C:/Program Files/nodejs/node.exe' `
  --env 'LTDS_OPS_ORIGIN=https://ops.ledgetopdroneservices.com' `
    'LTDS_MCP_AGENT_ID=hermes' 'LTDS_MCP_ALLOW_WRITES=false' `
    'LTDS_CLOUDFLARED_PATH=C:/Users/fstor/.codex/cache/windows-package-inputs-cloudflared-2026.10.3/cloudflared.exe' `
  --args 'C:/Projects/Ledge Top Operations/operations-private-mcp/apps/operations-mcp/src/cli.mjs'
hermes mcp test ledgetop_operations
```

The supported CLI explicitly instructs open sessions to use `/reload-mcp`, or
start a new session. This does not restart Hermes itself or create a new daemon.

A Hermes process on another host cannot use this PC's absolute script paths or
human login cache. Install the adapter there with verified Node/cloudflared and
complete that host's own authorized login. A hosted client unable to launch
stdio needs a separately reviewed remote transport and authentication design.

## Acceptance and boundaries

Ask `get_connection`, then search only the intended client and preserve its
returned source-qualified identifiers for detail reads. Local writes remain
disabled for all three agents. Agent IDs label diagnostics; they do not create
separately scoped identities. The backend still enforces the human's current
permissions.

The reviewed update is now installed; fresh connections advertise ten read
tools including `get_existing_public_link`. Existing Codex/Claude processes were
not forcibly restarted and may retain their original nine-tool inventory.
Claude supports reconnecting the named server through `/mcp`; no generic
hot-reload command for the current Codex app was established. Reconnect that
server through the app's supported controls when convenient, rather than killing
or replacing the app-server. See [Claude MCP connection management](https://code.claude.com/docs/en/mcp)
and [OpenAI MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The existing-link tool uses an existing
authorized GET and never creates a link. For a file, pass its `files[].id` from
`list_delivery_folder` as `itemRef`, with the exact containing folder prefix.
Returned complete links are bearer access and belong only in the requesting
authorized user's result, never shared diagnostics or agent-bus messages.
