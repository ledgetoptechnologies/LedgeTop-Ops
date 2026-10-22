# Private Operations MCP

A local stdio MCP server for the owner's Codex, Claude, and Hermes installations.
It calls existing Operations HTTPS APIs with the owner's current **human Cloudflare
Access login**. It does not create a public endpoint, accept client agents, use an
OpenAI API key, change the Workers, or bypass backend permissions.

## Install and connect

Requirements: Node.js 24+, [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
and an existing Operations staff account with the appropriate permissions. Native
client creation also requires current native staff admission and directory grants.

From the repository root:

```powershell
npm.cmd ci --prefix apps/operations-mcp
npm.cmd --prefix apps/operations-mcp run login
npm.cmd --prefix apps/operations-mcp run doctor
```

The login command opens the normal Access browser flow and captures its output so
the JWT is never printed. Cloudflared maintains its own expiring local token cache.
The doctor command performs only a session request and prints sanitized identity,
capabilities, and connection settings. Normal Operations login bookkeeping can
update last-seen metadata. Login must finish before calling tools. Tool calls never
start an interactive login or automatically refresh an expired session.

For staging, set `LTDS_OPS_ORIGIN` to the **exact staging HTTPS origin** before login,
doctor, and server startup. Never authenticate production credentials against an
untrusted origin. The origin comes only from trusted local configuration, not tool
arguments or client record content.

### Codex

Add this to your trusted local MCP configuration, replacing the absolute path:

```toml
[mcp_servers.ledgetop_operations]
command = "node"
args = ["C:/ABSOLUTE/PATH/Operations/apps/operations-mcp/src/cli.mjs"]

[mcp_servers.ledgetop_operations.env]
LTDS_OPS_ORIGIN = "https://ops.ledgetopdroneservices.com"
LTDS_MCP_AGENT_ID = "codex"
LTDS_MCP_ALLOW_WRITES = "false"
```

### Claude Desktop / Claude Code

Use this server entry in the client-supported `mcpServers` configuration:

```json
{
  "mcpServers": {
    "ledgetop_operations": {
      "command": "node",
      "args": ["C:/ABSOLUTE/PATH/Operations/apps/operations-mcp/src/cli.mjs"],
      "env": {
        "LTDS_OPS_ORIGIN": "https://ops.ledgetopdroneservices.com",
        "LTDS_MCP_AGENT_ID": "claude",
        "LTDS_MCP_ALLOW_WRITES": "false"
      }
    }
  }
}
```

### Hermes

Add to the appropriate profile's `config.yaml`:

```yaml
mcp_servers:
  ledgetop_operations:
    command: node
    args:
      - C:/ABSOLUTE/PATH/Operations/apps/operations-mcp/src/cli.mjs
    env:
      LTDS_OPS_ORIGIN: https://ops.ledgetopdroneservices.com
      LTDS_MCP_AGENT_ID: hermes
      LTDS_MCP_ALLOW_WRITES: "false"
```

Use an absolute `node` executable path if the client cannot resolve it. Set
`LTDS_CLOUDFLARED_PATH` to an absolute cloudflared executable path if needed.
Restart/reload the client's MCP connection after editing its configuration.
Each machine or operating-system account running an agent needs its own login.
Hosted/cloud agents cannot directly launch this local stdio server.

## Tools and authority

Read mode advertises ten tools:

| Tool | Purpose |
| --- | --- |
| `get_connection` | Inspect sanitized staff identity, capabilities, and local write setting |
| `find_clients` | Search canonical, source-specific client records |
| `get_client` | Inspect one exact client record |
| `get_client_access` | Inspect external access and pending states |
| `list_delivery_folder` | Browse authorized folder references |
| `get_existing_public_link` | Read an already active link for an exact authorized folder/file; never create or renew one |
| `list_delivery_grants` | Inspect bindings and current grants |
| `find_grant_audiences` | Search authorized recipients for a binding |
| `preview_delivery_access` | Review recipients, expiry, and context; performs a read-only POST |
| `get_client_creation_options` | Inspect permitted sources, scopes, and organizations |

For an existing public link, first browse the authorized folder and retain its
exact prefix (and `itemRef` for a file). `get_existing_public_link` reads the
existing share through the same server authorization as the sharing dialog,
including `delivery.share.create` permission to recover its URL. It returns
`share: null` when no active share exists; it never creates one as a fallback.
An active legacy share may have `shareUrl: null` and `recoverable: false`; do not
invent its URL or rotate its credential. The returned complete URL contains a
bearer credential: reveal it only to the requesting authorized user, and exclude
it from diagnostics, shared agent discussions, and acceptance receipts. An access
code is never returned.

Set `LTDS_MCP_ALLOW_WRITES="true"` in a **trusted local connection configuration**
to additionally advertise `create_client`, `grant_delivery_access`, and
`revoke_delivery_access`. This is a local guard, not a backend permission grant.
All server-side role, division, native admission, source, feature, and deployment
checks still apply. Keep the MCP client's normal approval controls enabled for
permission changes; act only on explicit owner requests.

`LTDS_MCP_AGENT_ID` is a diagnostic request label. It is **not an authenticated
agent identity or separate delegated credential**. Backend audits attribute actions
to the signed-in staff user. The first version deliberately shares that user's
existing authority. Separate server-enforced agent scopes/revocation and unattended
remote access require a future delegated authentication design. Removing a local
MCP configuration stops that connection; invalidating the Access session follows
your existing Access policies and expiry rules.

Example requests after connecting:

- “Find Acme and show its current portal access.”
- “Check which recipients have access to this delivery folder.”
- “Retrieve the existing public link for this specific delivery folder.”
- “Preview granting this specific client access to this folder.”
- With writes enabled: “Create this client record using the selected source and business area.”

Client creation, identity enrollment, portal activation, folder binding, and
delivery permission are separate workflows. Creating a record does not grant a
login or send an invitation. This release grants deliveries only through an
**existing authorized binding and recipient**. It does not automate enrollment,
create folder bindings, merge shared profiles, or recover authority. If the person
is not enrolled, finish the existing portal confirmation workflow first.

## Safe retries and results

- Preserve the exact `source_id`, `root_namespace`, `route_kind`, and `public_id`
  returned by lookup. `pa_public_id` is a different identifier.
- Preview access first and use the returned normalized `operation` fields plus
  `contextVersion` as `expectedContextVersion` for a grant. Review dynamic group
  audiences: future members can gain access too.
- Generate one lowercase UUIDv4 `operationId` or `mutationId` per intended change.
  Preserve it and the exact arguments after a timeout, disconnection, or uncertain
  result. The adapter never retries a write automatically or generates a new ID.
- `create_client` prepares admission and creates the record with the same key.
  A creation retry repeats these same steps with the same input. Inspect `status`
  and destinations: `pending` does not mean remote synchronization is complete.
- Revoke using the logical `grantId` and observed `version` from the grants list,
  not the physical row `id`. Stale versions and context conflicts require a fresh
  read/review, not a blind overwrite.
- A denied or failed request does not prove a timed-out mutation was rolled back.
  Inspect current state and retry the **same** operation when appropriate.

## Operational limits

The adapter follows no redirects, accepts only JSON from its configured origin,
limits requests/responses to 1 MiB, and times out each HTTPS call after 20 seconds.
Each mutation obtains fresh CSRF credentials internally. Tokens, CSRF secrets, raw
subprocess output, and raw error bodies are excluded from tool results and logs.
Tool results still contain authorized client business data: only connect trusted
agent clients. Website/record text is untrusted data, not agent instructions.

Expired login, non-JSON Access redirects, 401/403, missing native permissions, or
disabled rollout features fail closed. Re-run login then doctor for authentication
problems. A 404 may indicate an unavailable feature, rather than a missing client.
No Worker deployment, database migration, or Cloudflare policy edit is required.

Local verification:

```powershell
npm.cmd --prefix apps/operations-mcp run check
npm.cmd --prefix apps/operations-mcp test
```

Tests include SDK client/server integration over both in-memory and real child
process stdio transports, endpoint mappings, write gating, CSRF, response bounds,
redirect rejection, redaction, and idempotency. They do not establish live
production readiness. Live acceptance is login → doctor → lookup → access
inspection; test writes against a staging fixture before enabling production
writes. No live write is needed to verify discovery or read access.

Initial acceptance on 2026-10-18: all 19 adapter tests and 24 repository layout
checks passed. A real child-process MCP client authenticated against Operations,
discovered nine read tools, searched the client directory, read an exact client
record, and inspected its external-access roster. Writes remained disabled; no
client records or permissions were changed. Write endpoints have local contract
coverage and still require staging acceptance before production enablement.

Protocol/client references: [MCP server development](https://modelcontextprotocol.io/docs/develop/build-server),
[Cloudflare Access CLI](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/),
[Codex MCP](https://developers.openai.com/codex/mcp),
[Claude MCP](https://code.claude.com/docs/en/mcp),
[Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).


## Separate staging machine mode

The human adapter above retains its ten default read tools and explicit browser
sign-in. Autonomous staging agents use a different entry point:

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/path/to/Operations/apps/operations-mcp/src/machine-cli.mjs"],
  "env": {
    "LTDS_MCP_MACHINE_CREDENTIAL_FILE": "C:/private/agent-specific/credential.private.json"
  }
}
```

This example does not register an MCP client. Each agent must have a distinct
credential file containing exactly `clientId` and `clientSecret`. Do not put their
values in MCP arguments, checked-in configuration, chat or logs. The file must be
regular and owned by the running user. On Windows disable ACL inheritance and
allow only the owner and optionally SYSTEM, with FullControl. Other users,
Administrators-group access, inherited rules and reparse-point paths are rejected.
On POSIX require owner-only access (mode0600 or stricter) and matching UID. The
adapter validates permissions without changing them. Keep parent directories
private too.

Run `node src/machine-cli.mjs doctor` with that environment for a connection GET.
`serve` (the default) advertises exactly `get_connection`, `find_clients` and
`get_client`. Discovery needs neither credentials nor network access. Actual
reads require separately provisioned Access service identity and current native
agent, owner and source authority. An Access token alone grants no native scope.

That offline discovery lists tools only. Call authenticated `get_connection` to
obtain `sources: [{sourceId, displayName}]`, then pass an exact returned source ID
to `find_clients`. Sources appear only when at least one current native record is
readable under both owner and machine policy, with the exact configured source,
visible connector, current identity head and live capability-only observer.
Revoked, denied, unavailable or empty sources are not advertised. Display names
come from the matched connector and never select identity or grant access.
The response additions pass through the older machine adapter unchanged; its
older description still calls the tool an inspection of the connection.

Machine mode is pinned to `https://ops-staging.ledgetopdroneservices.com` and only
GET `/api/agent/v1/connection`, `/api/agent/v1/clients`, or the source-qualified
client-detail route. Lookup requires `sourceId` and accepts query, cursor and
limit1-25. Detail requires exact `sourceId` and `recordId`; names and emails do not
prove identity. No production override, human session, cloudflared fallback,
cookies, writes, files or finance tools exist. Redirects are rejected, TLS
verification remains enabled, requests time out after20 seconds and JSON responses
are limited to1MiB. Diagnostics are generic; credential values and JWTs are
redacted. Authorized profile data still requires a trusted agent client and must
be treated as untrusted content.

Each request reloads and validates the credential file. Rotate it atomically at
the same path, retaining private ownership/permissions. Unsafe or malformed
replacement fails before network access. There is no automatic retry or human
login fallback. Local tests cover real SDK stdio discovery, Windows ACL privacy,
rotation, malformed files, fixed routes, rejected writes, TLS-disable rejection,
redaction and response bounds. They do not establish live staging readiness. This
adapter does not create keys, Access applications, native grants or MCP client
registrations.
