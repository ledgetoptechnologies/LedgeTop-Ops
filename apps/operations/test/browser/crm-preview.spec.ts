import { expect, test, type Page } from "@playwright/test";

// Rows shaped like the draft CRM read API (ops.crm.synthetic-read.v1) using Hermes's synthetic fixture values.
const base = { source_system: "hermes-crm-fixture" };
const contacts = [
  { ...base, source_table: "contacts", source_record_id: 101, company_name: "Fixture Prospect", contact_name: "Example Contact", email: "prospect@example.invalid",
    has_website: -1, status: "Research", contact_type: "Business", outreach_paused: 1, skip_auto_research: 0, notes: null },
  { ...base, source_table: "contacts", source_record_id: 102, company_name: "Fixture School", contact_name: null, email: null, has_website: 0,
    status: "Unclassified Legacy Status", contact_type: "School", sport: "Football", outreach_paused: 0, skip_auto_research: 0 },
];
const children: Record<string, unknown[]> = {
  "contact-log": [
    { ...base, source_table: "contact_log", source_record_id: 201, contact_id: 101, log_date: "2026-10-02", log_type: "draft_created", source: "gmail", account: "ltds", occurred_at: null, outcome: "draft" },
    { ...base, source_table: "contact_log", source_record_id: 203, contact_id: 101, log_date: "2026-10-04", log_type: "email_received", source: "gmail", account: "ltt", occurred_at: "2026-10-04T14:00:00Z", outcome: "reply" },
  ],
  followups: [{ ...base, source_table: "followups", source_record_id: 301, contact_id: 101, action_kind: "draft_review", responsibility: "us", completed: 0 }],
  // Same numeric id as a contact_log row: shown as its own record.
  interactions: [{ ...base, source_table: "interactions", source_record_id: 201, contact_id: 101, interaction_date: "2026-10-03", type: "Call", notes: "Separate legacy interaction" }],
  "status-history": [{ ...base, source_table: "status_history", source_record_id: 401, contact_id: 101, old_status: "New", new_status: "Research", changed_at: "2026-10-01T12:00:00Z", changed_by: "fixture-operator" }],
};

async function mock(page: Page, permissions: string[], crm: "on" | "off" = "on") {
  const requests: string[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "owner", email: "owner@example.test", displayName: "Owner", status: "Active", profileType: "Administrator", isAdministrator: true, permissions, divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    const crmRead = /^\/api\/admin\/crm\/synthetic\/([a-z-]+)$/.exec(url.pathname);
    if (crmRead) {
      requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
      if (crm === "off") return route.fulfill({ status: 404, json: { error: "Not found" } });
      const kind = crmRead[1]!;
      const all = kind === "contacts" ? contacts : (children[kind] ?? []).filter(row => String((row as { contact_id: number }).contact_id) === url.searchParams.get("contact_id"));
      // The contact log pages one row at a time so the UI must ask for the rest.
      const after = Number(url.searchParams.get("after") ?? 0), size = kind === "contact-log" ? 1 : 100;
      const remaining = (all as Array<{ source_record_id: number }>).filter(row => row.source_record_id > after);
      const items = remaining.slice(0, size);
      return route.fulfill({ json: { schema: "ops.crm.synthetic-read.v1", sourceSystem: "hermes-crm-fixture", items,
        page: { nextAfter: remaining.length > size ? items.at(-1)!.source_record_id : null } } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return requests;
}

test("the owner reads synthetic CRM contacts and one contact's separate history without any writes", async ({ page }, testInfo) => {
  page.on("dialog", dialog => { void dialog.dismiss(); throw new Error("Native dialog is forbidden"); });
  const requests = await mock(page, ["team.view", "crm.import.manage"]);
  await page.goto("/clients/crm");
  await expect(page.getByRole("note")).toContainText("Sample data preview");
  await expect(page.getByRole("note")).toContainText("aren't linked to clients");
  const fixture = page.getByRole("button", { name: /Fixture Prospect/ });
  await expect(fixture).toContainText("Outreach paused");
  await expect(fixture).toContainText("Not linked to a client");
  await expect(page.getByRole("button", { name: /Fixture School/ })).toContainText("Unclassified Legacy Status");
  await fixture.click();
  await expect(fixture).toHaveAttribute("aria-pressed", "true");
  const log = page.getByRole("region", { name: "Contact log" });
  await expect(log).toContainText("Draft, not sent");
  await expect(log).toContainText("Oct 2, 2026");
  // A longer history is never shown as complete: the rest loads on request.
  await expect(log).not.toContainText("Email received");
  await log.getByRole("button", { name: "Show more contact log" }).click();
  await expect(log).toContainText("Email received");
  await expect(log.getByRole("button", { name: "Show more contact log" })).toHaveCount(0);
  expect(requests).toContain("GET /api/admin/crm/synthetic/contact-log?contact_id=101&limit=100&after=201");
  await expect(page.getByRole("region", { name: "Interactions" })).toContainText("Separate legacy interaction");
  await expect(page.getByRole("region", { name: "Status history" })).toContainText("New → Research");
  await expect(page.getByRole("region", { name: "Follow-ups" })).toContainText("Open");
  expect(requests.every(request => request.startsWith("GET "))).toBe(true);
  expect(requests).toContain("GET /api/admin/crm/synthetic/contact-log?contact_id=101&limit=100");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("crm-preview.png"), fullPage: true });
});

test("the preview explains when it is switched off, and is hidden without the owner permission", async ({ page }) => {
  await mock(page, ["team.view", "crm.import.manage"], "off");
  await page.goto("/clients/crm");
  await expect(page.getByRole("alert")).toContainText("switched off here");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const requests = await mock(page, ["team.view"]);
  await page.goto("/clients");
  if ((page.viewportSize()?.width || 0) <= 960) await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "CRM preview" })).toHaveCount(0);
  expect(requests).toHaveLength(0);
});
