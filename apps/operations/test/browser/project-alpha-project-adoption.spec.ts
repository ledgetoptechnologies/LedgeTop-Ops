import { expect, test, type Page } from "@playwright/test";

const sourceId = "project-alpha:staging";
const firstPublicId = "1".repeat(32);
const secondPublicId = "2".repeat(32);
const reviewItemId = "10000000-0000-4000-8000-000000000001";
const reservationId = "20000000-0000-4000-8000-000000000002";
const commandId = "30000000-0000-4000-8000-000000000003";

type Captured = { headers: Record<string, string>; body: unknown };

async function fixture(page: Page, sourceRegistry: { status?: number; body?: unknown } = { body: { sources: [sourceId] } }) {
  const review: Captured[] = [], reserve: Captured[] = [], bind: Captured[] = [], finalize: Captured[] = [];
  const candidateReads: string[] = [];
  let reviewAttempts = 0, reserveAttempts = 0, connectorReads = 0, finalizeAttempts = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const capture = async (target: Captured[]) => target.push({ headers: request.headers(), body: request.postDataJSON() });
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test",
      displayName: "Admin", status: "Active", profileType: "Administrator", isAdministrator: true,
      permissions: ["administration.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/admin/integrations/project-alpha/connectors") {
      connectorReads += 1;
      return route.fulfill({ json: {
      connectors: connectorReads === 1 ? [] : [{ sourceId: "project-alpha:primary", displayName: "Primary Project Alpha",
        producerBindingId: "staging", snapshotOrigin: "https://pa.invalid",
        snapshotBasePath: "/api", applicationKey: "staging", profile: "business_data", state: "active",
        readVisible: true, activeRevision: 1, version: 1 }], health: [], legacyPrimary: false,
      } });
    }
    if (path === "/api/admin/integrations/project-alpha/api-v2/sources")
      return route.fulfill({ status: sourceRegistry.status ?? 200, json: sourceRegistry.body ?? { error: "disabled" } });
    if (path === "/api/admin/project-alpha/private/projects/adoption/candidates") {
      candidateReads.push(request.url());
      const cursor = url.searchParams.get("cursor");
      return route.fulfill({ json: { outcome: { status: "observed", authorizationGeneration: "4",
        projects: [{ publicId: cursor ? secondPublicId : firstPublicId, revision: "1", projectionSha256: "a".repeat(64),
          name: cursor ? "Second candidate" : "First candidate", status: "active", archived: false,
          organizationPublicId: "b".repeat(32), clientPublicId: null,
          organizationRecordId: "organization-1", clientRecordId: null }], nextCursor: cursor ? "3".repeat(32) : firstPublicId } } });
    }
    if (path === "/api/admin/project-alpha/private/projects/adoption/review") {
      await capture(review); reviewAttempts += 1;
      return route.fulfill({ json: { outcome: reviewAttempts === 1 ? { status: "uncertain", reason: "database" }
        : { status: "reviewed", reviewItemId, requestSha256: "c".repeat(64), replayed: true } } });
    }
    if (path === "/api/admin/project-alpha/private/projects/adoption/reserve") {
      await capture(reserve); reserveAttempts += 1;
      return route.fulfill({ json: reserveAttempts === 1 ? { status: "uncertain", reason: "database" }
        : { status: "reserved", reservationId, reviewItemId, idempotencyKey: reserve[0]!.headers["idempotency-key"], replayed: true } });
    }
    if (path === "/api/admin/project-alpha/private/projects/adoption/bind") {
      await capture(bind);
      return route.fulfill({ json: { status: "planned", bridgeId: "40000000-0000-4000-8000-000000000004",
        reservationId, commandId, requestSha256: "d".repeat(64), replayed: false } });
    }
    if (path === "/api/admin/project-alpha/private/projects/adoption/finalize") {
      await capture(finalize); finalizeAttempts += 1;
      return route.fulfill({ json: finalizeAttempts === 1
        ? { stage: "dispatch", outcome: { status: "uncertain", reason: "lost_ack" } }
        : { stage: "activate", outcome: { status: "activated", activationId: reviewItemId, replayed: true } } });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return { review, reserve, bind, finalize, candidateReads };
}

test("operator explicitly reviews, reserves, and queues an unbound Project with frozen retries", async ({ page }) => {
  const captured = await fixture(page);
  const confirmations: string[] = [];
  page.on("dialog", async dialog => { confirmations.push(dialog.message()); await dialog.accept(); });
  await page.goto("/administration");
  const panel = page.getByRole("region", { name: "PA-created Project adoption review" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Project Alpha source")).toHaveValue(sourceId);
  await expect(panel.getByLabel("Project Alpha source").locator("option:checked")).toHaveText(sourceId);

  await panel.getByRole("button", { name: "Find authorized unbound Projects" }).click();
  await expect(panel.getByText("First candidate")).toBeVisible();
  await panel.getByRole("button", { name: "Load next 50 Projects" }).click();
  await expect(panel.getByText("Second candidate")).toBeVisible();
  await panel.getByLabel(/First candidate/).check();
  await panel.getByLabel("New, unused Operations Project ID").fill("ops-pa-first-1");
  await panel.getByRole("button", { name: "Reserve destination and create review evidence" }).click();
  await expect(panel.getByText(/outcome is uncertain/)).toBeVisible();
  await expect(panel.getByLabel("Project Alpha source")).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Load next 50 Projects" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(page.getByRole("heading", { name: "Primary Project Alpha" })).toBeVisible();
  await panel.getByRole("button", { name: "Retry frozen review request" }).click();

  expect(captured.review).toHaveLength(2);
  expect(captured.review[1]!.headers["idempotency-key"]).toBe(captured.review[0]!.headers["idempotency-key"]);
  expect(captured.review[1]!.body).toEqual(captured.review[0]!.body);
  expect(captured.review[0]!.body).toEqual({ sourceId, externalProjectId: "ops-pa-first-1", projectAlphaPublicId: firstPublicId });
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toContain("Durably reserve this Operations Project ID");
  expect(confirmations[0]).toContain("retained even if you reset");
  expect(confirmations[0]).toContain("does not bind, grant access, or publish");
  await expect(panel.getByRole("status")).toContainText("Operations destination reserved; review evidence created:");

  await panel.getByRole("button", { name: "Reserve reviewed intent" }).click();
  await expect(panel.getByText(/reservation outcome is uncertain/)).toBeVisible();
  await panel.getByRole("button", { name: "Retry frozen reservation request" }).click();
  expect(captured.reserve).toHaveLength(2);
  expect(captured.reserve[1]!.headers["idempotency-key"]).toBe(captured.reserve[0]!.headers["idempotency-key"]);
  expect(captured.reserve[1]!.body).toEqual(captured.reserve[0]!.body);
  expect(captured.reserve[0]!.body).toEqual({ reviewItemId, idempotencyKey: captured.reserve[0]!.headers["idempotency-key"] });

  await panel.getByRole("button", { name: "Create local bind plan and queue command" }).click();
  expect(captured.bind).toHaveLength(1);
  expect(captured.bind[0]!.headers["idempotency-key"]).toBe(reservationId);
  expect(captured.bind[0]!.body).toEqual({ reservationId });
  await expect(panel.getByText(`Bind command queued locally: ${commandId}. Project Alpha acknowledgement is not yet confirmed.`)).toBeVisible();
  await expect(panel.getByText(/No step in this panel grants client access or publishes/)).toBeVisible();
  await expect(panel).not.toContainText("acknowledged");
  await panel.getByRole("button", { name: "Finalize and verify Project binding" }).click();
  await expect(panel.getByRole("alert")).toContainText("stopped at dispatch (uncertain)");
  await expect(panel.getByRole("alert")).toContainText("do not queue a replacement command");
  const references = panel.getByRole("group", { name: "Project adoption recovery references" });
  await expect(references).toContainText("ops-pa-first-1");
  await expect(references).toContainText(reservationId);
  await expect(references).toContainText(commandId);
  await expect(references).toContainText(captured.review[0]!.headers["idempotency-key"]!);
  await expect(references).toContainText(captured.reserve[0]!.headers["idempotency-key"]!);
  await expect(panel).not.toContainText("binding verified and Operations mapping activated");
  await panel.getByRole("button", { name: "Resume verification of the same bind command" }).click();
  expect(captured.finalize).toHaveLength(2);
  expect(captured.finalize[0]!.body).toEqual({ reservationId, commandId });
  expect(captured.finalize[1]).toEqual(captured.finalize[0]);
  expect(captured.finalize[0]!.headers["idempotency-key"]).toBe(commandId);
  expect(captured.bind).toHaveLength(1);
  await expect(panel.getByRole("status")).toContainText("Project Alpha binding verified and Operations mapping activated");
  await expect(panel.getByRole("status")).toContainText("Client access and portal publication remain unchanged");
  await expect(panel.getByRole("button", { name: /verify Project binding|Resume verification/ })).toHaveCount(0);
  await expect(references).toContainText(commandId);
});

for (const scenario of [
  { name: "empty", registry: { body: { sources: [] } }, message: "No enabled API-v2 sources are available for Project adoption." },
  { name: "malformed", registry: { body: { sources: [sourceId, "not a source"] } }, message: "Project adoption source configuration could not be verified." },
  { name: "disabled", registry: { status: 404, body: { error: "not found" } }, message: "Project adoption source discovery is disabled." },
] as const) {
  test(`Project adoption fails closed when the canonical API-v2 source registry is ${scenario.name}`, async ({ page }) => {
    const captured = await fixture(page, scenario.registry);
    await page.goto("/administration");
    const panel = page.getByRole("region", { name: "PA-created Project adoption review" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(panel.getByLabel("Project Alpha source")).toHaveValue("");
    await expect(panel.getByLabel("Project Alpha source")).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Find authorized unbound Projects" })).toBeDisabled();
    expect(captured.candidateReads).toHaveLength(0);
    expect(captured.review).toHaveLength(0);
    expect(captured.reserve).toHaveLength(0);
    expect(captured.bind).toHaveLength(0);
    expect(captured.finalize).toHaveLength(0);
  });
}
