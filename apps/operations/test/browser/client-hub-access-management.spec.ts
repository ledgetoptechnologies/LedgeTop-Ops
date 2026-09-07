import { expect, test } from "@playwright/test";

function detail(blocked: boolean, manage: boolean) {
  return { client: { workspace_id: "workspace-one", source_id: "project-alpha:primary", root_namespace: "business", kind: "organization", route_kind: "organizations", public_id: "pa-org",
    display_name: "Acme", status: "active", portal_status: "active", account_count: 1, project_count: 0, request_count: 0 },
    contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    capabilities: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "root-one",
    portalIdentities: { items: [{ workspace_id: "workspace-one", public_id: "principal-one", row_key: "principal-one", display_name: "Alex Client", email_hint: "alex@example.test",
      status: "active", identity_id: null, has_workspace_access: 0, blocked: blocked ? 1 : 0, binding_status: "unlinked", principalContextVersion: `principal-${blocked}`,
      hasExplicitAccess: false, accessLoaded: false, effectiveEmailBlockCount: blocked ? 1 : 0, effectiveSubjectBlock: false, removableEmailBlockId: blocked ? "block-one" : null,
      actions: { canRetryInvitation: manage, canCreateEmailBlock: manage && !blocked, canReviewEligibilityBlocks: manage },
      invitation: { id: "invite-one", status: "pending", expires_at: "2026-08-30T00:00:00Z", email_status: "failed", attempts: 2, last_error_code: "E_TEMP" } }],
      page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 }, contextVersion: "root-one", refreshedAt: "2026-08-25T12:00:00Z",
      capabilities: { canManageEligibilityBlocks: manage, canManagePortal: manage } } };
}

test("administrator manages invitation delivery and portal eligibility from client detail", async ({ page }) => {
  let detailRequests = 0;
  let invitationRetries = 0;
  let blocksCreated = 0;
  let blocksRevoked = 0;
  let blocked = false;

  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Administrator", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["team.view"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/client-hub/organizations/pa-org") {
      detailRequests += 1;
      return route.fulfill({ json: detail(blocked, true) });
    }
    if (path === "/api/team/clients/workspace-one/principal-one/invitation/retry") {
      invitationRetries += 1;
      expect(request.method()).toBe("POST");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      return route.fulfill({ json: { outcome: "queued", replayed: false } });
    }
    if (path === "/api/team/clients/eligibility-blocks") {
      blocksCreated += 1;
      blocked = true;
      expect(request.method()).toBe("POST");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(await request.postDataJSON()).toMatchObject({ email: "alex@example.test", reasonCode: "operator_opt_out" });
      return route.fulfill({ status: 201, json: { id: "block-one", replayed: false } });
    }
    if (path === "/api/team/clients/eligibility-blocks/block-one/revoke") {
      blocksRevoked += 1;
      blocked = false;
      expect(await request.postDataJSON()).toEqual({ reasonCode: "operator_opt_in" });
      return route.fulfill({ json: { id: "block-one", replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/clients/organizations/pa-org");
  await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Portal logins" })).toBeVisible();

  page.on("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Retry invitation delivery" }).click();
  await expect.poll(() => invitationRetries).toBe(1);
  await expect.poll(() => detailRequests).toBeGreaterThan(1);

  await page.getByRole("button", { name: "Block portal sign-in" }).click();
  await expect.poll(() => blocksCreated).toBe(1);
  await expect(page.getByRole("button", { name: "Remove sign-in block" })).toBeVisible();

  await page.getByRole("button", { name: "Remove sign-in block" }).click();
  await expect.poll(() => blocksRevoked).toBe(1);
  await expect(page.getByRole("button", { name: "Block portal sign-in" })).toBeVisible();
});

test("client detail does not expose management actions without server capabilities", async ({ page }) => {
  let mutationRequests = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-viewer", email: "viewer@example.test", displayName: "Viewer", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions: ["team.view"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/client-hub/organizations/pa-org") return route.fulfill({ json: detail(false, false) });
    if (path.startsWith("/api/team/clients/")) mutationRequests += 1;
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/clients/organizations/pa-org");
  await expect(page.getByRole("heading", { name: "Portal logins" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client access management" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry invitation delivery" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Block portal sign-in" })).toHaveCount(0);
  expect(mutationRequests).toBe(0);
});

test("authoritative revoked root access controls the client header and portal restoration action", async ({ page }) => {
  let mutationRequests = 0;
  const revokedDetail = { ...detail(false, true), portalRootAccess: {
    available: true, state: "revoked" as const, version: 3, reasonCode: "operator_root_revocation",
    updatedAt: "2026-09-05T12:00:00.000Z", canRevoke: false, canRestore: true,
  } };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Administrator", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["team.view"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/client-hub/organizations/pa-org") return route.fulfill({ json: revokedDetail });
    if (route.request().method() !== "GET") mutationRequests += 1;
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/clients/organizations/pa-org");
  await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible();
  await expect(page.getByText("Portal access revoked", { exact: true })).toBeVisible();
  const rootAccess = page.getByRole("region", { name: "Client workspace portal access", exact: true });
  await expect(rootAccess).toContainText("Current and future people cannot enter this workspace");
  await expect(rootAccess.getByRole("button", { name: "Restore workspace portal access", exact: true })).toBeVisible();
  await expect(rootAccess.getByRole("button", { name: "Revoke workspace portal access", exact: true })).toHaveCount(0);
  expect(mutationRequests).toBe(0);
});
