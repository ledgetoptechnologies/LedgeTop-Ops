import { expect, test, type Page } from "@playwright/test";

const clientPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const detailApi = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const notesApi = `${detailApi}/internal-notes`;
const root = { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "42" };
function detail() { return { client: { workspace_id: null, public_id: "42", kind: "organization", route_kind: "organizations",
  source_id: "project-alpha:primary", root_namespace: "business", detail_path: clientPath, display_name: "Acme Construction",
  status: "active", portal_status: "not_provisioned", account_count: 0, project_count: 0, request_count: 0, contact_count: 0 },
  contextVersion: "context-one", contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [],
  viewerGrants: [], capabilities: { directory: true, requests: false, delivery: false, viewer: false }, internalNotesAvailable: true } }
function workspace(notes: unknown[] = [], canManageNotes = true) { return { canonicalRoot: root, contextVersion: "context-one", notes,
  capabilities: { canManageNotes } }; }
async function mock(page: Page, mutate?: (request: { method: string; key: string | null; body: unknown }) => Promise<{ status: number; body: unknown }>) {
  let notes: Array<Record<string,unknown>> = [], writes = 0; const seen: Array<{ method: string; key: string | null; body: unknown }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test",
      displayName: "Staff", status: "Active", profileType: "Administrator", isAdministrator: true,
      permissions: ["team.view","client.notes.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", capabilities: {} } });
    if (url.pathname === detailApi) return route.fulfill({ json: detail() });
    if (url.pathname === notesApi && request.method() === "GET") return route.fulfill({ json: workspace(notes) });
    if (url.pathname.startsWith(notesApi) && request.method() !== "GET") {
      const value = { method: request.method(), key: request.headers()["idempotency-key"] || null, body: request.postDataJSON() }; seen.push(value); writes += 1;
      if (mutate) { const result = await mutate(value); return route.fulfill({ status: result.status, json: result.body }); }
      notes = [{ id: "11111111-1111-4111-8111-111111111111", version: 1, title: "Site preference", body: "Call first.",
        createdBy: "staff-one", updatedBy: "staff-one", createdAt: "2026-09-02T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z",
        revisions: [{ version: 1, action: "created", actorId: "staff-one", createdAt: "2026-09-02T12:00:00.000Z" }] }];
      return route.fulfill({ status: 201, json: { noteId: notes[0]!.id, version: 1, deleted: false, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { seen, writes: () => writes };
}
test("internal notes are clearly private, responsive, and create within the exact Client Hub root", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 }); const state = await mock(page); await page.goto(clientPath);
  const region = page.getByRole("region", { name: "Internal client notes" });
  await expect(page.getByText("No portal workspace linked", { exact: true })).toBeVisible();
  await expect(region.getByText("Operations staff only.", { exact: false })).toBeVisible();
  await expect(region).toContainText("never shown in the client portal or synchronized to Project Alpha");
  await region.getByRole("button", { name: "Add note" }).click();
  await region.getByLabel("Title").fill("Site preference"); await region.getByLabel("Note").fill("Call first.");
  await region.getByRole("button", { name: "Save note" }).click();
  await expect(region.getByRole("heading", { name: "Site preference" })).toBeVisible();
  expect(state.seen[0]).toMatchObject({ method: "POST", body: { expectedContextVersion: "context-one", title: "Site preference", body: "Call first." } });
  expect(state.seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(region.locator("article").first()).toHaveCSS("min-width", "0px");
});

test("an uncertain save preserves the draft and retries with the same idempotency key", async ({ page }) => {
  let attempt = 0, committed = false; const state = await mock(page, async () => {
    attempt += 1; if (attempt === 1) return { status: 503, body: { error: "Temporary interruption" } };
    committed = true; return { status: 201, body: { noteId: "11111111-1111-4111-8111-111111111111", version: 1, deleted: false, replayed: false } };
  });
  // Make the verification GET expose the committed record on the second try.
  await page.unroute("**/api/**");
  const seen: Array<{ key: string | null }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["team.view","client.notes.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", capabilities: {} } });
    if (url.pathname === detailApi) return route.fulfill({ json: detail() });
    if (url.pathname === notesApi && request.method() === "GET") return route.fulfill({ json: workspace(committed ? [{ id: "11111111-1111-4111-8111-111111111111", version: 1,
      title: "Remember", body: "Keep this draft", createdBy: "staff-one", updatedBy: "staff-one", createdAt: "2026-09-02T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z",
      revisions: [{ version: 1, action: "created", actorId: "staff-one", createdAt: "2026-09-02T12:00:00.000Z" }] }] : []) });
    if (url.pathname === notesApi && request.method() === "POST") { seen.push({ key: request.headers()["idempotency-key"] || null }); attempt += 1;
      if (attempt === 1) return route.fulfill({ status: 503, json: { error: "Temporary interruption" } }); committed = true;
      return route.fulfill({ status: 201, json: { noteId: "11111111-1111-4111-8111-111111111111", version: 1, deleted: false, replayed: false } }); }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto(clientPath); const region = page.getByRole("region", { name: "Internal client notes" });
  await region.getByRole("button", { name: "Add note" }).click(); await region.getByLabel("Title").fill("Remember");
  await region.getByLabel("Note").fill("Keep this draft"); await region.getByRole("button", { name: "Save note" }).click();
  await expect(region.getByRole("alert")).toContainText("Temporary interruption");
  await expect(region.getByLabel("Title")).toHaveValue("Remember"); await region.getByRole("button", { name: "Save note" }).click();
  await expect(region.getByRole("heading", { name: "Remember" })).toBeVisible(); expect(seen).toHaveLength(2); expect(seen[1]!.key).toBe(seen[0]!.key);
});

test("a stale edit reloads the current version without discarding the operator draft", async ({ page }) => {
  let version = 1;
  const record = () => ({ id: "11111111-1111-4111-8111-111111111111", version, title: "Gate instructions",
    body: version === 1 ? "Old source text" : "Another operator changed this", createdBy: "staff-one", updatedBy: "staff-two",
    createdAt: "2026-09-02T12:00:00.000Z", updatedAt: "2026-09-02T12:05:00.000Z",
    revisions: [{ version, action: version === 1 ? "created" : "updated", actorId: "staff-two", createdAt: "2026-09-02T12:05:00.000Z" }] });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["team.view","client.notes.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", capabilities: {} } });
    if (url.pathname === detailApi) return route.fulfill({ json: detail() });
    if (url.pathname === notesApi && request.method() === "GET") return route.fulfill({ json: workspace([record()]) });
    if (url.pathname.startsWith(`${notesApi}/`) && request.method() === "PATCH") { version = 2;
      return route.fulfill({ status: 409, json: { error: "Client notes changed" } }); }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto(clientPath); const region = page.getByRole("region", { name: "Internal client notes" });
  await region.getByRole("button", { name: "Edit" }).click(); await region.getByLabel("Note").fill("My preserved draft");
  await region.getByRole("button", { name: "Save note" }).click(); await expect(region.getByRole("alert")).toContainText("Reload the latest version");
  await region.getByRole("button", { name: "Reload latest version" }).click(); await expect(region.getByLabel("Note")).toHaveValue("My preserved draft");
});
