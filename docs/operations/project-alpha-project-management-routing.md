# Project Alpha project-management routing

Operations does not create an authoritative Project Alpha project. A staff
member opens a reviewed Project Alpha destination from the exact Client Hub
source record, creates the project there, and then waits for that source's
normal synchronization to project the record back into Operations.

## Source-owned configuration

Migration `0046_project_alpha_project_management_routes.sql` adds one optional
project-management route per registered Project Alpha source. The route is a
separate, revisioned connector purpose. It never derives from
`snapshot_origin`, and it contains no connector credential or grant.

An administrator with a current global, non-denied `integrations.manage`
permission configures it with:

`PUT /api/admin/integrations/project-alpha/connectors/:sourceId/project-management`

```json
{
  "expectedConnectorVersion": 4,
  "expectedVersion": null,
  "idempotencyKey": "a-unique-operation-key",
  "reviewedUrlTemplate": "https://alpha.example.com/customers/{recordId}/projects/new"
}
```

`expectedVersion` is `null` only for the first configuration. Later changes
use the current route version. Sending `reviewedUrlTemplate: null` creates an
audited disabled revision. An exact retry with the same actor and operation key
returns the original result; using the key for different input fails.

The reviewed URL must be canonical HTTPS without user information, a query, or
a fragment. It may contain one `{recordId}` placeholder only as a complete path
segment. A static HTTPS project-management URL is also accepted. The audit
records only whether the route is enabled and whether it is a base URL or a
record-path template; it does not duplicate the URL.

Connector administration reads include a separate `projectManagement` array.
An absent array means the application/database contract is not coordinated;
an empty array means the migration is available but no source has a route.

## Client Hub action contract

The exact-source staff action is read with:

`GET /api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/project-management`

It is available only for a live `business` organization or standalone-client
root whose immutable source mapping belongs to the same source. Operations
substitutes that mapping's exact external record ID, URL-encodes it as a path
segment, and rechecks the connector, route revision, and mapping before
returning the link. It never guesses from the Client Hub ID, portal workspace,
business-party membership, snapshot origin, or another source.

The response includes:

- `canonicalRoot` and `contextVersion` for refresh-safe UI validation;
- a sanitized source identity and availability explanation;
- either an external `Create project in Project Alpha` HTTPS action or `null`;
- sanitized synchronization status and timestamps;
- a same-origin GET affordance that refreshes this status; and
- the existing exact-source synchronization POST only when the caller still
  has global `integrations.manage` authority.

Pending, suspended, retired, hidden, unregistered, unmapped, disabled, or
concurrently changed sources fail closed. Reading the action does not write a
project, audit event, notification, grant, or synchronization job.

### Original primary synchronization compatibility

The original `project-alpha:primary` synchronization predates the connector
registry. While its deployment-owned HTTPS endpoint, application key, and
read credential remain configured, Client Hub may show that exact source's
immutable record mapping and synchronization health even when the registry is
still empty. This compatibility path is primary-only and read-only: it does
not create a connector, route, credential, workspace, membership, or grant.
An authorized administrator may request the existing primary synchronization
through its legacy same-origin endpoint.

Project creation remains unavailable until an administrator deliberately
enrolls the primary connector and reviews a project-management URL. Secondary
sources never inherit this compatibility behavior or the primary source's
health, mapping, synchronization action, or destination.

## Operator workflow

1. Activate and expose the exact source connector.
2. Review its Project Alpha staff project-management URL.
3. Save the route from the connection administration page.
4. Open the exact source record in Client Hub.
5. Open Project Alpha in a new tab and create the project there.
6. Return to Operations and refresh synchronization status. Administrators may
   request the existing exact-source sync; other staff wait for scheduled sync.

If configuration changes while a workspace is open, refresh both the client
workspace and the action status. Do not compensate by creating an Operations
project or by constructing a URL from the snapshot endpoint.
