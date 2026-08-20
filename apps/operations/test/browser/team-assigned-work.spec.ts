import { expect, test, type Page } from "@playwright/test";

const operation = {
  id: "operation-1",
  title: "North parcel mapping",
  project_name: "North Site",
  division_name: "Flight Operations",
  scheduled_start: "2026-08-15T15:00:00.000Z",
  status: "scheduled",
};

async function mock(page: Page, options: { administrator?: boolean; canManageEligibilityBlocks?: boolean; canManagePortal?: boolean } = {}) {
  let assignedWorkRequests = 0;
  let invitationRetries = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-viewer",
          email: "viewer@example.test",
          displayName: "Viewer",
          status: "Active",
          profileType: "Employee",
          isAdministrator: options.administrator ?? false,
          permissions: ["team.view", "operations.view", "sops.view"],
          divisions: [],
        },
        csrfToken: "csrf-test",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: {},
      } });
    } else if (path === "/api/team/staff") {
      await route.fulfill({ json: { staff: [{
        id: "staff-pilot",
        display_name: "Colin Pilot",
        email: "pilot@example.test",
        status: "active",
        roles: "Pilot",
        sync_protected: 0,
      }] } });
    } else if (path === "/api/team/clients") {
      await route.fulfill({ json: { clients: [{
        workspace_id: "workspace-one", public_id: "principal-one", display_name: "Alex Client",
        workspace_name: "Acme Workspace",
        email_hint: "alex@example.test", status: "active", identity_id: null, issuer: null, subject: null,
        has_workspace_access: 0, blocked: 0,
        access: [], invitation: options.canManagePortal ? { id: "invite-one", status: "pending", expires_at: "2026-08-30T00:00:00Z",
          email_status: "failed", attempts: 2, last_error_code: "E_TEMP" } : null,
      }], blocks: [], canManageEligibilityBlocks: options.canManageEligibilityBlocks ?? false,
        canManagePortal: options.canManagePortal ?? false } });
    } else if (path === "/api/team/clients/workspace-one/principal-one/invitation/retry") {
      invitationRetries += 1;
      await route.fulfill({ json: { outcome: "queued", replayed: false } });
    } else if (path === "/api/team/staff/staff-pilot/assigned-work") {
      assignedWorkRequests += 1;
      await route.fulfill({ json: {
        operations: [{
          id: operation.id,
          title: operation.title,
          status: operation.status,
          scheduledStart: operation.scheduled_start,
          projectName: operation.project_name,
          briefAvailable: true,
          canViewSops: true,
          sopCount: 2,
        }],
        truncated: false,
      } });
    } else if (path === "/api/operations") {
      await route.fulfill({ json: { operations: [operation] } });
    } else if (path === "/api/operations/operation-1/job-brief") {
      await route.fulfill({ json: {
        operation: {
          id: operation.id,
          title: operation.title,
          status: operation.status,
          scheduledStart: operation.scheduled_start,
          scheduledEnd: null,
          location: "North parcel",
          navigation: null,
        },
        brief: {
          version: 2,
          items: [],
          attachments: [],
          sops: [{
            sopId: "sop-mapping",
            revisionId: "revision-mapping-3",
            revisionNumber: 3,
            slug: "mapping-flight",
            title: "Mapping Flight SOP",
            purpose: "Standard capture checks.",
            html: "<p>Confirm the flight plan.</p>",
            toc: [],
            author: { id: "staff-admin", displayName: "Admin" },
            publishedAt: "2026-08-01T12:00:00.000Z",
            linkedAt: "2026-08-02T12:00:00.000Z",
            publicationState: "current",
          }],
          createdAt: "2026-08-02T12:00:00.000Z",
          updatedAt: "2026-08-02T12:00:00.000Z",
          updatedBy: { id: "staff-admin", displayName: "Admin", email: "admin@example.test" },
        },
        history: [],
        canEdit: false,
        canViewSops: true,
        canAssignSops: false,
      } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
  return { assignedWorkRequests: () => assignedWorkRequests, invitationRetries: () => invitationRetries };
}

test("Team lazily exposes only visible assigned work and opens its pinned-SOP brief", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/team");
  await expect(page.getByRole("heading", { name: "Colin Pilot" })).toBeVisible();
  expect(state.assignedWorkRequests()).toBe(0);

  const summary = page.getByText("Assigned work", { exact: true });
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("2 SOPs", { exact: true })).toBeVisible();
  expect(state.assignedWorkRequests()).toBe(1);

  const link = page.getByRole("link", { name: "Open job brief" });
  await expect(link).toBeVisible();
  if ((page.viewportSize()?.width || 0) <= 960)
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await link.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/operations\?brief=operation-1$/);
  await expect(page.getByText("LTDS brief v2")).toBeVisible();
  const quickSop = page.getByRole("link", { name: "Mapping Flight SOP Revision 3" });
  await quickSop.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#job-brief-sop-revision-mapping-3$/);
  await expect(page.locator(".job-brief-sop strong", { hasText: "Mapping Flight SOP" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Team keeps Staff and Clients as responsive keyboard-accessible directories", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.goto("/team");
  const staff = page.getByRole("tab", { name: "Staff" });
  const clients = page.getByRole("tab", { name: "Clients" });
  await expect(clients).toHaveCSS("color", "rgb(21, 27, 34)");
  await clients.focus();
  await page.keyboard.press("Enter");
  await expect(clients).toHaveAttribute("aria-selected", "true");
  await expect(staff).toHaveCSS("color", "rgb(21, 27, 34)");
  await expect(page.getByRole("heading", { name: "Alex Client" })).toBeVisible();
  await expect(page.getByText("Awaiting first login")).toBeVisible();
  await expect(page.getByText("None explicitly granted")).toBeVisible();
  await expect(page.getByText(/Eligibility and login never grant project files/)).toBeVisible();
  expect((await clients.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Team shows invitation failure and retries it through the guarded staff endpoint", async ({ page }) => {
  const state = await mock(page, { administrator: true, canManagePortal: true });
  page.on("dialog", dialog => void dialog.accept());
  await page.goto("/team");
  await page.getByRole("tab", { name: "Clients" }).click();
  await expect(page.getByText("Invitation failed")).toBeVisible();
  await expect(page.getByText("E_TEMP")).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry invitation delivery" });
  await retry.click();
  await expect.poll(state.invitationRetries).toBe(1);
});

test("Team hides client eligibility mutations when management rollout is off", async ({ page }) => {
  await mock(page, { administrator: true, canManageEligibilityBlocks: false });
  await page.goto("/team");
  await page.getByRole("tab", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Alex Client" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Block portal eligibility" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove opt-out" })).toHaveCount(0);
});
