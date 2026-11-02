import { expect, test, type Page, type Route } from "@playwright/test";

const user = {
  id: "staff-share", email: "admin@example.test", displayName: "Share Admin", status: "Active", profileType: "Administrator", isAdministrator: true,
  permissions: ["administration.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"], divisions: [],
};
function recipient(overrides: Record<string, unknown> = {}) {
  return { recipientId: "rcp-lori", recipientVersion: "v-lori-1", type: "client", displayName: "Lori Koschnick", organizationName: "Coldwell",
    portal: { state: "ready" }, memberCount: 2, lastActivityAt: "2026-11-01T15:00:00.000Z", ...overrides };
}
const recent = [recipient(), recipient({ recipientId: "rcp-birch", recipientVersion: "v-birch-1", type: "organization", displayName: "Birch Builders",
  organizationName: null, memberCount: 5 }), recipient({ recipientId: "rcp-dune", recipientVersion: "v-dune-1", displayName: "Dune Farms",
  organizationName: null, portal: { state: "not_set_up" }, memberCount: null, lastActivityAt: null })];
function grant(overrides: Record<string, unknown> = {}) {
  return { grantId: "grant-lori", version: 1, recipientId: "rcp-lori", recipientLabel: "Lori Koschnick", recipientType: "client",
    audienceLabel: "Everyone in Lori Koschnick's portal", recipientCount: 2, status: "active", expiresAt: null, updatedAt: "2026-11-02T15:00:00.000Z",
    canRevoke: true, ...overrides };
}
type Call = { path: string; method: string; query: URLSearchParams; body: any; key?: string };

async function mock(page: Page, options: { unavailable?: boolean; projectFolder?: unknown; listBody?: unknown; recipients?: (query: string) => unknown[]; grants?: unknown[];
  onCreate?: (route: Route, attempt: number) => Promise<unknown> | undefined; preview?: (body: any) => unknown } = {}) {
  const calls: Call[] = []; let grants = options.grants ?? []; let creates = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const call: Call = { path: url.pathname, method: request.method(), query: url.searchParams,
      body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"] };
    calls.push(call);
    if (call.path === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { deliveryJobsRoot: { enabled: true }, authenticatedDeliveryGrants: { enabled: true, creationEnabled: true } } } });
    if (call.path === "/api/delivery/folders") return route.fulfill({ json: { prefix: "Jobs/Clients/", folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/",
      name: "Acme", displayName: "Acme", kind: "folder" }], files: [], nextCursor: null } });
    if (call.path === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (call.path === "/api/delivery/shares/active") return route.fulfill({ json: { share: null } });
    if (call.path === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    if (call.path.startsWith("/api/delivery/client-recipients") && options.unavailable) return route.fulfill({ status: 404, json: { error: "Not found" } });
    if (call.path === "/api/delivery/client-recipients") {
      const q = url.searchParams.get("q") ?? "";
      const rows = options.recipients ? options.recipients(q) : recent.filter(item => item.displayName.toLowerCase().includes(q.toLowerCase()));
      return route.fulfill({ json: options.listBody ?? { mode: q ? "search" : "recent", projectFolder: options.projectFolder ?? false, recipients: rows } });
    }
    if (call.path === "/api/delivery/client-recipients/grants" && call.method === "GET") return route.fulfill({ json: { grants } });
    if (call.path === "/api/delivery/client-recipients/grants/preview") return route.fulfill({ json: options.preview ? options.preview(call.body)
      : { previewVersion: "p-1", recipientId: call.body.recipientId, recipientLabel: "Lori Koschnick", audienceLabel: "Everyone in Lori Koschnick's portal",
        recipientCount: 2, expiresAt: call.body.expiresAt } });
    if (call.path === "/api/delivery/client-recipients/grants" && call.method === "POST") {
      const custom = options.onCreate?.(route, ++creates); if (custom) return custom;
      const created = grant({ expiresAt: call.body.expiresAt }); grants = [created];
      return route.fulfill({ status: 201, json: { grant: created, replayed: false } });
    }
    if (call.path === "/api/delivery/client-recipients/grants/grant-lori/revoke") {
      const revoked = grant({ status: "revoked", version: 2 }); grants = [revoked];
      return route.fulfill({ json: { grant: revoked, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}
async function openClientTab(page: Page) {
  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  await page.getByRole("tab", { name: "Client Workspace" }).click();
}
const posts = (calls: Call[], path: string) => calls.filter(call => call.path === path && call.method === "POST");

test("sharing opens on recent clients with no division or connection to choose, and shares exactly the reviewed client", async ({ page }) => {
  const calls = await mock(page);
  await openClientTab(page);
  const panel = page.getByRole("region", { name: "Share with a client" });
  await expect(panel.getByText("Recent clients", { exact: true })).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Clients" }).getByRole("option")).toHaveCount(3);
  await expect(page.getByRole("option", { name: /Lori Koschnick Coldwell · Portal ready · 2 people/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Birch Builders Whole organization/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Portal connection" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Business division" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Share folder" })).not.toContainText(/division|Project Alpha/i);
  const lists = calls.filter(call => call.path === "/api/delivery/client-recipients");
  expect(lists[0]!.query.get("q")).toBe(""); expect(lists[0]!.query.get("folderRef")).toBe("folder-acme");
  expect([...lists[0]!.query.keys()].sort()).toEqual(["folderRef", "limit", "q"]);

  await page.getByRole("searchbox", { name: "Search clients" }).fill("lori");
  await expect(panel.getByText("Matching clients", { exact: true })).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Clients" }).getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: /Lori Koschnick/ }).click();
  await page.getByRole("button", { name: "Review sharing" }).click();
  const review = page.getByRole("region", { name: "Review sharing with a client" });
  await expect(page.getByRole("heading", { name: "Confirm sharing" })).toBeFocused();
  await expect(review).toContainText("Everyone in Lori Koschnick's portal (2 people now)");
  await expect(review).toContainText("When revoked");
  await page.getByRole("button", { name: "Share folder" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Shared with Lori Koschnick." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Client access to this folder" })).toContainText("Lori Koschnick");

  const [previewCall] = posts(calls, "/api/delivery/client-recipients/grants/preview");
  expect(previewCall!.body).toEqual({ folderRef: "folder-acme", recipientId: "rcp-lori", recipientVersion: "v-lori-1", audience: "all_members", expiresAt: null });
  const [create] = posts(calls, "/api/delivery/client-recipients/grants");
  expect(create!.body).toEqual({ ...previewCall!.body, previewVersion: "p-1" });
  expect(create!.key).toBeTruthy();
  // Nothing from the older per-division flow is used.
  expect(calls.some(call => call.path.includes("/authenticated-grants") || call.path.includes("/native-grants"))).toBe(false);
});

test("without the new client list on the server, the existing sharing panel is shown unchanged", async ({ page }) => {
  await mock(page, { unavailable: true });
  await openClientTab(page);
  await expect(page.getByRole("combobox", { name: "Portal connection" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Share with a client" })).toHaveCount(0);
  await expect(page.getByText("Client sharing could not be loaded", { exact: false })).toHaveCount(0);
});

test("a project folder keeps the project grant flow and its access terms", async ({ page }) => {
  const calls = await mock(page, { projectFolder: true });
  await openClientTab(page);
  await expect(page.getByRole("combobox", { name: "Portal connection" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Share with a client" })).toHaveCount(0);
  expect(calls.some(call => call.path === "/api/delivery/client-recipients/grants")).toBe(false);
});

for (const [label, listBody] of [
  ["a list that doesn't say whether this is a project folder", { mode: "recent", recipients: [] }],
  ["a list with an unexpected field", { mode: "recent", projectFolder: false, recipients: [], divisions: [] }],
  ["a list for the wrong mode", { mode: "search", projectFolder: false, recipients: [] }],
] as const) test(`the client list refuses ${label}`, async ({ page }) => {
  await mock(page, { listBody });
  await openClientTab(page);
  await expect(page.getByRole("alert").filter({ hasText: "could not be verified" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Portal connection" })).toHaveCount(0);
});

test("a client without a working portal can't be shared with yet", async ({ page }) => {
  await mock(page);
  await openClientTab(page);
  await page.getByRole("option", { name: /Dune Farms .*Portal not set up yet/ }).click();
  await expect(page.getByRole("button", { name: "Review sharing" })).toBeDisabled();
  await expect(page.getByText("Dune Farms can't receive files until someone is in their portal.")).toBeVisible();
});

test("a chosen end date is sent exactly and shown in the review", async ({ page }) => {
  const calls = await mock(page);
  await openClientTab(page);
  await page.getByRole("option", { name: /Lori Koschnick/ }).click();
  await page.getByRole("radio", { name: "Until a date" }).check();
  await page.getByRole("button", { name: "Review sharing" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose a future date" })).toBeVisible();
  await page.getByLabel("Access ends on").fill("2099-01-31");
  await page.getByRole("button", { name: "Review sharing" }).click();
  await expect(page.getByRole("region", { name: "Review sharing with a client" })).toContainText("2099");
  const [previewCall] = posts(calls, "/api/delivery/client-recipients/grants/preview");
  expect(previewCall!.body.expiresAt).toBe(new Date("2099-01-31T23:59:59").toISOString());
});

for (const [label, rows] of [
  ["a row carrying a division", [{ ...recipient(), divisionId: "division-north" }]],
  ["a row carrying an email", [{ ...recipient(), email: "lori@example.test" }]],
  ["an unknown portal state", [recipient({ portal: { state: "linked" } })]],
  ["a duplicated client", [recipient(), recipient()]],
] as const) test(`the client list refuses ${label}`, async ({ page }) => {
  const calls = await mock(page, { recipients: () => [...rows] as unknown[] });
  await openClientTab(page);
  await expect(page.getByRole("alert").filter({ hasText: "could not be verified" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  expect(posts(calls, "/api/delivery/client-recipients/grants/preview")).toHaveLength(0);
});

test("a preview for another client or end date is refused", async ({ page }) => {
  const calls = await mock(page, { preview: body => ({ previewVersion: "p-1", recipientId: "rcp-birch", recipientLabel: "Birch Builders",
    audienceLabel: "Everyone", recipientCount: 5, expiresAt: body.expiresAt }) });
  await openClientTab(page);
  await page.getByRole("option", { name: /Lori Koschnick/ }).click();
  await page.getByRole("button", { name: "Review sharing" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be verified" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Review sharing with a client" })).toHaveCount(0);
  expect(posts(calls, "/api/delivery/client-recipients/grants")).toHaveLength(0);
});

test("an unconfirmed share keeps the dialog locked and retries the exact same request", async ({ page }) => {
  let release: (() => void) | undefined;
  const calls = await mock(page, { onCreate: (route, attempt) => attempt === 1
    ? new Promise<void>(resolve => { release = resolve; }).then(() => route.abort("connectionfailed")) : undefined });
  await openClientTab(page);
  await page.getByRole("option", { name: /Lori Koschnick/ }).click();
  await page.getByRole("button", { name: "Review sharing" }).click();
  await page.getByRole("button", { name: "Share folder" }).click();
  await expect(page.getByRole("button", { name: "Sharing…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  release!();
  await expect(page.getByRole("alert").filter({ hasText: "The outcome isn't confirmed yet." })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry the same action" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Shared with Lori Koschnick." })).toBeVisible();
  const [first, second] = posts(calls, "/api/delivery/client-recipients/grants");
  expect(second!.body).toEqual(first!.body); expect(second!.key).toBe(first!.key);
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
});

test("a stale review is discarded and has to be reviewed again", async ({ page }) => {
  const calls = await mock(page, { onCreate: route => route.fulfill({ status: 409, json: { error: "recipient_changed" } }) });
  await openClientTab(page);
  await page.getByRole("option", { name: /Lori Koschnick/ }).click();
  await page.getByRole("button", { name: "Review sharing" }).click();
  await page.getByRole("button", { name: "Share folder" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "changed since you reviewed it" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Review sharing with a client" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry the same action" })).toHaveCount(0);
  expect(posts(calls, "/api/delivery/client-recipients/grants")).toHaveLength(1);
});

test("revoking asks first, can be cancelled without a request, and sends the exact version", async ({ page }) => {
  const calls = await mock(page, { grants: [grant()] });
  await openClientTab(page);
  const access = page.getByRole("region", { name: "Client access to this folder" });
  await expect(access).toContainText("Lori Koschnick");
  await expect(access).toContainText("until revoked");
  await access.getByRole("button", { name: "Revoke…" }).click();
  await access.getByRole("button", { name: "Keep access" }).click();
  expect(calls.some(call => call.path.endsWith("/revoke"))).toBe(false);
  await access.getByRole("button", { name: "Revoke…" }).click();
  await access.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Access for Lori Koschnick was revoked." })).toBeVisible();
  await expect(access).toContainText("revoked");
  const revoke = calls.find(call => call.path.endsWith("/grant-lori/revoke"));
  expect(revoke!.body).toEqual({ expectedVersion: 1 }); expect(revoke!.key).toBeTruthy();
});
