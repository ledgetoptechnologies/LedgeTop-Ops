import { expect, test, type Page } from "@playwright/test";

const controls = {
  allOperations: false, sopAssignment: false, deliveryBrowse: false, deliveryLinkCreate: false,
  deliveryLinkRevoke: false, deliveryLinkAudit: false, teamRoster: false, administration: false,
  viewerAccess: false, viewerDatasets: false, viewerProcessing: false, viewerPublish: false,
  viewerShareCreate: false, viewerShareRevoke: false, viewerClientAccess: false, viewerStoragePurge: false,
};
const roster = [
  { id: "staff-native-hire", email: "hire@example.test", display_name: "Native Hire", status: "active", roles: "",
    provisioning_source: "local", sync_protected: 1, owner_role: false, access_controls_editable: false, localControls: controls },
  { id: "staff-role-owner", email: "owner@example.test", display_name: "Role Owner", status: "active", roles: "Owner",
    provisioning_source: "local", sync_protected: 1, owner_role: true, access_controls_editable: false, localControls: controls },
  { id: "staff-imported", email: "imported@example.test", display_name: "Imported Operator", status: "active", roles: "Operator",
    provisioning_source: "project-alpha", sync_protected: 0, owner_role: false, access_controls_editable: true, localControls: controls },
];
const csrf = "c".repeat(43);
type Entry = { permission: string; state: string; operation: "grant" | "revoke" | null; editable: boolean; reason: string | null };

async function mockTeam(page: Page, options: { postStatus?: number; nativeReady?: boolean; accessStatus?: number } = {}) {
  let revision = 0;
  const entries: Entry[] = [
    { permission: "team.view", state: "none", operation: "grant", editable: true, reason: null },
    { permission: "delivery.browse", state: "inherited", operation: null, editable: false, reason: "inherited" },
    { permission: "viewer.publish", state: "deny", operation: null, editable: false, reason: "target_denied" },
    { permission: "operations.view_all", state: "none", operation: "grant", editable: false, reason: "actor_lacks_permission" },
  ];
  const posts: unknown[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["team.view", "roles.manage"], divisions: [] },
      csrfToken: "csrf-team", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/native-staff/session" && options.nativeReady === false) return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/native-staff/session") return route.fulfill({ json: {
      csrfToken: `1.${"a".repeat(64)}`, verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() } });
    if (path === "/api/team/staff" && request.method() === "GET") return route.fulfill({ json: { staff: roster } });
    if (/^\/api\/team\/staff\/[^/]+\/assigned-work$/.test(path)) return route.fulfill({ json: { operations: [], truncated: false } });
    if (path === "/api/staff-operations-access/staff-native-hire") {
      if (options.accessStatus) return route.fulfill({ status: options.accessStatus, json: { error: "Not found" } });
      if (request.method() === "GET") return route.fulfill({ json: { staffId: "staff-native-hire", targetAdmissionVersion: 1, revision,
        targetEditable: true, targetReason: null, permissions: entries, csrfToken: csrf,
        verifiedUntil: new Date(Date.now() + 600_000).toISOString() } });
      expect(request.headers()["x-csrf-token"]).toBe(csrf);
      const body = request.postDataJSON() as { commandId: string; permission: string; operation: "grant" | "revoke"; expectedRevision: number };
      posts.push(body);
      if (options.postStatus && posts.length === 1) return route.fulfill({ status: options.postStatus, json: { error: "staff_operations_access_unavailable" } });
      revision = body.expectedRevision + 1;
      const entry = entries.find(item => item.permission === body.permission)!;
      Object.assign(entry, body.operation === "grant" ? { state: "allow", operation: "revoke" } : { state: "none", operation: "grant" });
      return route.fulfill({ json: { receipt: { commandId: body.commandId, staffId: "staff-native-hire", permission: body.permission,
        operation: body.operation, revision, replayed: posts.length > 1 } } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return posts;
}
const card = (page: Page, name: string) => page.locator(".staff-card").filter({ has: page.getByRole("heading", { name, exact: true }) });

test("the Operations access panel renders the server's per-permission decision and sends one exact command", async ({ page }) => {
  const posts = await mockTeam(page);
  await page.goto("/team");
  await expect(card(page, "Role Owner").getByRole("region", { name: /Operations access/ })).toHaveCount(0);
  await expect(card(page, "Imported Operator").getByRole("region", { name: /Operations access/ })).toHaveCount(0);
  const panel = card(page, "Native Hire").getByRole("region", { name: "Native Hire Operations access" });
  await expect(panel.getByText("View the team roster")).toBeVisible();
  await expect(panel.getByText("From role", { exact: false })).toBeVisible();
  await expect(panel.getByText("Denied", { exact: false }).first()).toBeVisible();
  const grant = panel.getByRole("button", { name: "Grant View the team roster" });
  await expect(grant).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Grant View all operations, projects, and tasks" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: /Browse delivery files/ })).toHaveCount(0);
  await panel.getByLabel("Reason for change").fill("Synthetic onboarding access");
  await expect(grant).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Grant View all operations, projects, and tasks" })).toBeDisabled();
  await grant.click();
  await expect(panel.getByRole("button", { name: "Revoke View the team roster" })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), permission: "team.view", operation: "grant",
    expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Synthetic onboarding access" });
});

test("an uncertain command keeps its commandId and is only retried by an explicit click", async ({ page }) => {
  const posts = await mockTeam(page, { postStatus: 503 });
  await page.goto("/team");
  const panel = card(page, "Native Hire").getByRole("region", { name: "Native Hire Operations access" });
  await panel.getByLabel("Reason for change").fill("Synthetic uncertain change");
  await panel.getByRole("button", { name: "Grant View the team roster" }).click();
  await expect(panel.getByText("The result is unknown. Reload, then retry this same change.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Grant View the team roster" })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(1);
  await panel.getByRole("button", { name: "Retry same change" }).click();
  await expect(panel.getByRole("button", { name: "Revoke View the team roster" })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
});

test("the panel follows its own GET when native session readiness is false", async ({ page }) => {
  const posts = await mockTeam(page, { nativeReady: false });
  await page.goto("/team");
  await expect(page.getByText("Employee management is not enabled in this environment.")).toBeVisible();
  const panel = card(page, "Native Hire").getByRole("region", { name: "Native Hire Operations access" });
  await expect(panel.getByText("View the team roster")).toBeVisible();
  await panel.getByLabel("Reason for change").fill("Synthetic production access");
  await panel.getByRole("button", { name: "Grant View the team roster" }).click();
  await expect(panel.getByRole("button", { name: "Revoke View the team roster" })).toBeVisible();
  expect(posts).toHaveLength(1);
});

for (const accessStatus of [404, 403]) test(`the panel renders nothing when its GET answers ${accessStatus}`, async ({ page }) => {
  let reads = 0;
  page.on("request", request => { if (request.url().includes("/api/staff-operations-access/")) reads++; });
  await mockTeam(page, { nativeReady: false, accessStatus });
  await page.goto("/team");
  await expect(card(page, "Native Hire").getByRole("heading", { name: "Native Hire", exact: true })).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(card(page, "Native Hire").getByRole("region", { name: /Operations access/ })).toHaveCount(0);
  await expect(page.getByText("You can't change Operations access.")).toHaveCount(0);
});

test("a transient GET failure shows the panel with Reload, which loads it", async ({ page }) => {
  let failing = true;
  await mockTeam(page, { nativeReady: false });
  await page.route("**/api/staff-operations-access/staff-native-hire", route =>
    failing ? route.fulfill({ status: 503, json: { error: "staff_operations_access_unavailable" } }) : route.fallback());
  await page.goto("/team");
  const panel = card(page, "Native Hire").getByRole("region", { name: "Native Hire Operations access" });
  await expect(panel.getByText("Operations access could not be loaded.")).toBeVisible();
  failing = false;
  await panel.getByRole("button", { name: "Reload" }).click();
  await expect(panel.getByText("View the team roster")).toBeVisible();
});
