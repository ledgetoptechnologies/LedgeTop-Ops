import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const endpoint = "/api/admin/integrations/project-alpha/connectors";
const primary = "project-alpha:primary", staging = "project-alpha:staging";
const correspondencePath = `${endpoint}/${encodeURIComponent(staging)}/portal-correspondence`;
const PROOF_SHA = "a".repeat(64), REVOKE_SHA = "b".repeat(64), REVISION = "11111111-2222-4333-8444-555555555555";

const connector = (sourceId: string, displayName: string, origin: string, profile: "primary_legacy" | "business_data") => ({
  sourceId, displayName, producerBindingId: sourceId, snapshotOrigin: origin, snapshotBasePath: "/", applicationKey: "ltds_ops",
  profile, state: "active", readVisible: true, activeRevision: 1, version: 2 });
const proof = (overrides: Record<string, unknown> = {}) => ({ directorySourceId: staging, portalSourceId: primary,
  sourceInstanceId: "0f1e2d3c-4b5a-4968-8776-655443322110", applicationId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  historyEpochId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", baseUrl: "https://pa-staging.example.test", producerBindingId: "ltds-staging",
  applicationKey: "ltds_ops", connectorRevision: 3, connectorVersion: 4, currentKeyFingerprint: "d".repeat(64), primaryAuthorityVersion: 5, ...overrides });
const readyStatus = () => ({ status: "ready", current: null, preview: { proof: proof(), proofSha256: PROOF_SHA } });
const activeStatus = (status = "ready", preview: unknown = null) => ({ status, current: { version: 1, state: "active", revisionId: REVISION,
  revocationProofSha256: REVOKE_SHA, approvedByStaffId: "admin", approvedAt: "2026-10-17T07:00:00.000Z" }, preview });
const requestSha = (body: Record<string, unknown>) => createHash("sha256").update(JSON.stringify({ directorySourceId: staging,
  operationId: body.operationId, action: body.action, expectedVersion: body.expectedVersion, expectedProofSha256: body.expectedProofSha256 })).digest("hex");

type Post = { body: Record<string, unknown>; key: string | null };
async function fixture(page: Page, options: { discovery: unknown; status?: () => unknown;
  post?: (body: Record<string, unknown>, attempt: number) => { status?: number; json: unknown } }) {
  const posts: Post[] = [];
  let gets = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active",
      profileType: "Administrator", isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === endpoint && request.method() === "GET") return route.fulfill({ json: {
      // The real connector map holds the physical primary connector, not the logical staging source.
      connectors: [connector(primary, "LTDS Project Alpha", "https://pa-staging.example.test", "primary_legacy")],
      legacyPrimary: true, health: [], portalDirectoryCorrespondence: options.discovery } });
    if (path === correspondencePath && request.method() === "GET") { gets += 1; return route.fulfill({ json: options.status ? options.status() : readyStatus() }); }
    if (path === correspondencePath && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      posts.push({ body, key: request.headers()["idempotency-key"] ?? null });
      const reply = options.post ? options.post(body, posts.length) : { json: { ok: true, operationId: body.operationId, action: body.action,
        directorySourceId: staging, requestSha256: requestSha(body), version: Number(body.expectedVersion) + 1,
        revisionId: body.action === "revoke" ? REVISION : "99999999-2222-4333-8444-555555555555", replayed: false } };
      return route.fulfill({ status: reply.status ?? 200, json: reply.json });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { posts, gets: () => gets };
}
const card = (page: Page) => page.getByRole("region", { name: "Client workspace connection" });

test("same-source production shows no card and makes no correspondence request", async ({ page }) => {
  const calls = await fixture(page, { discovery: { status: "not_required", candidates: [] } });
  await page.goto("/administration");
  await expect(page.getByRole("region", { name: "LTDS Project Alpha connection" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(calls.gets()).toBe(0);
});

test("connecting sends the exact frozen command and names both sides by business and domain", async ({ page }) => {
  const calls = await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: staging, review: readyStatus() }] } });
  await page.goto("/administration");
  const sides = card(page).getByRole("group", { name: "Connected sides" });
  await expect(sides).toContainText("Business records");
  await expect(sides).toContainText("LTDS Project Alpha");
  await expect(sides).toContainText("Ledge Top Drone Services client portal");
  // The proof base URL is the Project Alpha server, never presented as the portal's domain.
  await expect(sides).not.toContainText("pa-staging.example.test");
  await expect(card(page)).toContainText("Project Alpha source: pa-staging.example.test");
  await expect(card(page)).toContainText("does not add anyone to a workspace or grant access to files");
  // Opaque source IDs stay inside the collapsed technical details.
  await expect(card(page).getByText(staging, { exact: true })).toBeHidden();
  await card(page).getByRole("button", { name: "Connect client workspaces" }).click();
  await expect(card(page).getByRole("status").filter({ hasText: "Client workspaces are connected" })).toBeVisible();
  expect(calls.posts).toHaveLength(1);
  const { body, key } = calls.posts[0]!;
  expect(Object.keys(body)).toEqual(["operationId", "action", "expectedVersion", "expectedProofSha256"]);
  expect(body).toMatchObject({ action: "approve", expectedVersion: 0, expectedProofSha256: PROOF_SHA });
  expect(key).toBe(body.operationId);
});

test("a schema-confirmed rejection releases the command and reloads the current status", async ({ page }) => {
  const calls = await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: staging, review: readyStatus() }] },
    post: body => ({ status: 409, json: { ok: false, code: "rejected", operationId: body.operationId } }) });
  await page.goto("/administration");
  await card(page).getByRole("button", { name: "Connect client workspaces" }).click();
  await expect(card(page).getByRole("alert")).toContainText("Nothing was changed");
  await expect(card(page).getByRole("button", { name: "Connect client workspaces" })).toBeEnabled();
  await expect(card(page).getByRole("button", { name: /Retry same/ })).toHaveCount(0);
  expect(calls.gets()).toBeGreaterThan(0);
});

for (const [label, reply] of [
  ["a 503 unknown outcome", (body: Record<string, unknown>) => ({ status: 503, json: { ok: false, code: "outcome_unknown", operationId: body.operationId } })],
  ["a 200 with a mismatched request hash", (body: Record<string, unknown>) => ({ json: { ok: true, operationId: body.operationId, action: body.action,
    directorySourceId: staging, requestSha256: "c".repeat(64), version: 1, revisionId: "99999999-2222-4333-8444-555555555555", replayed: false } })],
  ["a 409 without the matching operation", () => ({ status: 409, json: { ok: false, code: "rejected", operationId: "someone-else" } })],
] as const) test(`${label} keeps the exact command frozen for retry only`, async ({ page }) => {
  let attempt = 0;
  const calls = await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: staging, review: readyStatus() }] },
    post: body => (++attempt === 1 ? reply(body) : { json: { ok: true, operationId: body.operationId, action: body.action, directorySourceId: staging,
      requestSha256: requestSha(body), version: 1, revisionId: "99999999-2222-4333-8444-555555555555", replayed: true } }) });
  await page.goto("/administration");
  await card(page).getByRole("button", { name: "Connect client workspaces" }).click();
  await expect(card(page).getByRole("alert")).toContainText("not confirmed");
  await expect(card(page).getByRole("button", { name: "Connect client workspaces" })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Check again" })).toHaveCount(0);
  await card(page).getByRole("button", { name: "Retry same connect request" }).click();
  await expect(card(page).getByRole("status").filter({ hasText: "Client workspaces are connected" })).toBeVisible();
  expect(calls.posts).toHaveLength(2);
  expect(calls.posts[1]!.body).toEqual(calls.posts[0]!.body);
  expect(calls.posts[1]!.key).toBe(calls.posts[0]!.key);
});

test("disconnect stays available when the upstream connection is unavailable, after an in-app confirmation", async ({ page }) => {
  const unavailable = { ...activeStatus("unavailable", null), reason: "producer" };
  const calls = await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: staging, review: unavailable }] },
    status: () => unavailable });
  await page.goto("/administration");
  await expect(card(page)).toContainText("Project Alpha did not confirm the connection details");
  await expect(card(page).getByRole("button", { name: "Connect client workspaces" })).toHaveCount(0);
  await card(page).getByRole("button", { name: "Disconnect" }).click();
  const confirm = page.getByRole("dialog", { name: "Disconnect client workspaces?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(calls.posts).toHaveLength(0);
  await card(page).getByRole("button", { name: "Disconnect" }).click();
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(card(page).getByRole("status").filter({ hasText: "Client workspaces are disconnected" })).toBeVisible();
  expect(calls.posts).toHaveLength(1);
  expect(calls.posts[0]!.body).toMatchObject({ action: "revoke", expectedVersion: 1, expectedProofSha256: REVOKE_SHA });
});

test("a changed connection is shown as needing review with a reconnect action", async ({ page }) => {
  const suspended = { ...activeStatus("suspended", { proof: proof(), proofSha256: PROOF_SHA }), reason: "changed" };
  await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: staging, review: suspended }] } });
  await page.goto("/administration");
  await expect(card(page)).toContainText("Needs review");
  await expect(card(page)).toContainText("changed since this link was approved");
  await expect(card(page).getByRole("button", { name: "Review and reconnect" })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Disconnect" })).toBeVisible();
});

for (const [label, bad] of [
  ["a non-UUID source instance", { sourceInstanceId: "instance-1" }],
  ["a non-hex key fingerprint", { currentKeyFingerprint: "fp-1" }],
  ["a non-HTTPS or non-canonical origin", { baseUrl: "http://pa-staging.example.test/" }],
  ["a zero connector version", { connectorVersion: 0 }],
] as const) test(`a preview proof with ${label} is rejected as unverifiable`, async ({ page }) => {
  await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: staging,
    review: { status: "ready", current: null, preview: { proof: proof(bad), proofSha256: PROOF_SHA } } }] } });
  await page.goto("/administration");
  await expect(card(page).getByRole("alert")).toContainText("could not be verified");
  await expect(card(page).getByRole("button", { name: "Connect client workspaces" })).toHaveCount(0);
});

test("an unverifiable discovery payload surfaces an error instead of hiding the card", async ({ page }) => {
  await fixture(page, { discovery: { status: "review", candidates: [{ directorySourceId: primary, review: readyStatus() }] } });
  await page.goto("/administration");
  await expect(card(page).getByRole("alert")).toContainText("could not be verified");
});
