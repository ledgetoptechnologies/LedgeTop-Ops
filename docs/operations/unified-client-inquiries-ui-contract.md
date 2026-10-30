# Unified client inquiry UI contract

This backend contract is aligned with the Claude-owned Client Portal UI. A generic inquiry enters Operations triage only; it is not a catalog service request, project request, LTT enrollment, or PA work item.

## Offer and form

GET /api/client/request-services retains its existing services and unavailable fields and adds inquiryKinds. It returns ["website","drone","other"] only when the authenticated principal currently has at least one request.create context; otherwise it returns an empty array. Hide the generic inquiry option when the array is empty.

Render one form with an explicit required kind choice from the offered inquiryKinds. The client sends only kind, optional nullable title, required details, and optional nullable location. There is no company, workspace, business, source, project, service-catalog, recipient, attachment, or permission selector. A Drone-only client may submit kind=website without LTT membership.

## Submit

POST /api/client/inquiries

Headers: Content-Type application/json, current portal Origin, and Idempotency-Key (stable random key per user submission; 16-128 letters/digits/period/underscore/colon/dash).

Strict body:

~~~json
{
  "kind": "website",
  "title": null,
  "details": "We need help updating our public site.",
  "location": null
}
~~~

Title may be a non-empty trimmed string up to 160 characters or null/omitted; the server supplies a kind-based default. Details are required, trimmed, and 1-4000 characters. Location is nullable/optional, trimmed, and at most 300 characters. Unknown fields are rejected.

Success is 201 for a new inquiry or 200 for an exact replay:

~~~json
{
  "inquiry": {
    "id": "opaque-id",
    "kind": "website",
    "title": "website inquiry",
    "details": "We need help updating our public site.",
    "location": null,
    "status": "received",
    "createdAt": "2026-10-30T00:00:00.000Z"
  }
}
~~~

Reusing a key with changed content returns 409. Invalid input returns 400. Missing/revoked request authority returns 403. For an uncertain network result, retry only with the same body and same key.

## History

GET /api/client/inquiries returns { inquiries: [...] }, newest first, for the authenticated portal identity. Inquiry statuses are received, under_review, declined, or closed. History is released only while the principal has a current eligible service-request context.

## Operations inbox and status

- GET /api/operations/inbox/inquiries?q=<optional search>&cursor=<optional opaque cursor> returns typed items with id, kind, title, details, location, status, and createdAt.
- PATCH /api/operations/inbox/inquiries/:id accepts one strict body: { status: under_review | declined | closed }.
- Only Operations staff with current global operations.manage can use these routes. The client UI must not link to or call them.

Owner email is dispatched by the existing scheduled staff-triage outbox using the existing configured recipient. Client submit success does not depend on mail delivery; the durable inquiry remains available in Operations.

## Staff notification delivery lifecycle

The outbox records `pending`, `processing`, `sent`, `failed`, `suppressed`, or `uncertain`. The processor runs the existing non-sending mail transport preflight before it claims any row. A missing or invalid transport leaves pending attempts untouched and logs only the closed mail failure code.

Typed failures known to occur before dispatch keep the existing bounded retry/backoff. An acceptance-ambiguous mail failure moves the row to `uncertain`; it is not sent again automatically. An expired `processing` lease is also `uncertain`, because the worker may have dispatched before it stopped. A successful mail send followed by a D1 receipt/audit failure leaves the lease for that same uncertain reconciliation path. Each hold writes a safe audit reason and raises the existing internal Operations alert. The stable mail Message-ID is for tracing and does not imply provider deduplication. Uncertain rows require owner/operator reconciliation; no automated resend is implied.
