# Unified client service requests

The client does not select a business or workspace. These endpoints discover
existing native memberships for the verified Client Portal principal. They do
not create or synchronize PA memberships, share access, or staff identities.
Quotes, contracts, invoices, and financial records remain owned by Project Alpha.

## Discover services

`GET /api/client/request-services` needs no workspace header. It returns:

```json
{
  "services": [{
    "serviceChoiceId": "svc1_...",
    "name": "Website changes",
    "summary": null,
    "category": "website",
    "catalogCategory": "Website support",
    "clientName": "Example client",
    "questions": [],
    "geometryRequirement": "none"
  }],
  "unavailable": []
}
```

`category` is display metadata derived from the explicit server source mapping:
primary/staging is `drone`, secondary/source-2-staging is `website`, and other
sources are `other`. Routing always uses the exact current workspace and catalog
source, irrespective of this display category. Never infer routing from names.

Choices for different client memberships remain distinct even if they have the
same service name. Show the client name when that distinction is necessary.
`serviceChoiceId` is a nonsecret locator, not an access grant. Retain it verbatim.

Discovery reads the existing root service catalog with its normal permissions.
Project-only request permission does not grant root catalog/request access. Such
accounts can appear under `unavailable` with `code: service_catalog_unavailable`;
keep the existing scoped project request flow available. An unavailable catalog
must not be presented as having no services. Legacy memberships without native
source scope are not converted to native memberships by these endpoints.

Discovery permits at most 32 native memberships, four concurrent catalog reads,
ten pages of 100 services per membership, 1,000 services total, and a 1 MiB aggregate response. A source
that cannot be read completely appears under `unavailable`. Aggregate capacity
exhaustion returns 503. One shared budget charges wire chunks before retaining
them and transformed response rows before appending catalog items. The wire
budget is 1 MiB across all sources/pages; response rows and envelope overhead
have a separate 1 MiB bound. Capacity exhaustion cancels active readers, stops
queued work, and fails the entire request rather than returning partial results.
Strict discovery propagates the real database membership sentinel overflow as
503; existing workspace-list callers retain their compatibility behavior.
Memberships are rediscovered after the catalog reads;
revoked memberships are removed before returning data.

## Submit a request

`POST /api/client/requests` requires the current same-origin credentials,
`Origin`, `Content-Type: application/json`, and an `Idempotency-Key` header using
the existing 16–128 character contract. For example:

```json
{
  "serviceChoiceId": "svc1_...",
  "title": "Update our home page",
  "details": "Please replace the introductory text.",
  "answers": {}
}
```

Optional fields are `projectId`, `location`, `preferredStartAt`,
`desiredCompletionAt`, `deliverables`, `siteContactName`, `siteContactEmail`,
`siteContactPhone`, `latitude`, `longitude`, `areaGeoJson`, and `poiPoints`.
The normal scoped request validator checks their exact formats and limits.
Do not send business, source, category, workspace, request type, or service arrays.
Unknown input fields are rejected.

The server rediscovers authorized memberships and rereads the selected catalog
item/version for the exact project target, when supplied. It then calls only the
existing same-app scoped request endpoint, replacing the workspace header and
preserving authentication, origin, and idempotency headers. That endpoint
reauthorizes the request and runs its normal source, assignment, required answer,
geometry, rate limit, maintenance, draft lifecycle, and idempotency checks.

Success retains the existing `{ request }` response: 201 for creation, 200 for
replay. Revoked/mismatched memberships return 404; a changed service/version
returns 409 `catalog_changed`; malformed choice/input returns 400. Scoped
validation errors and conflicts pass through, including 422 for missing required
answers/geometry and 409 for assignment or idempotency conflicts. Keep the same
key when retrying identical content and use a fresh key for changed content.

Requests with attachments can continue using the existing scoped draft flow.
This API adds no financial mutation or shared profile synchronization behavior.
