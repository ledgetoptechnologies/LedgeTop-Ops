import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./client-onboarding-staff-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Staff onboarding browser fixture did not compile.");

const consumerId = "33333333-3333-4333-8333-333333333333", businessId = "77777777-7777-4777-8777-777777777777";
const ORIGIN = "https://ops.onboarding.test";
type Call = { path: string; body: Record<string, unknown> };

async function render(page: Page, mode = "success", search = "", clock = false) {
  if (clock) await page.clock.install();
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(`${ORIGIN}/administration/client-onboarding${search}`);
  await page.evaluate(value => { (window as Window & { onboardingMode?: string }).onboardingMode = value; }, mode);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
}
const calls = (page: Page) => page.evaluate(() => (window as Window & { onboardingCalls?: Call[] }).onboardingCalls ?? []) as Promise<Call[]>;
const bodies = async (page: Page, route: string) => (await calls(page)).filter(call => call.path.endsWith(`/${route}`)).map(call => call.body);
async function chooseScope(page: Page) {
  await page.getByRole("combobox", { name: /^Business area/ }).selectOption({ label: "Drone Services" });
  await page.getByRole("combobox", { name: /^Division/ }).selectOption({ label: "Whole business area" });
}
async function openSubmission(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { name: `Review ${name}` })).toBeVisible();
}

test("Client Hub keeps navigation behind the onboarding dialog and protects an in-flight create", async ({ page }) => {
  await render(page, "delayed-create", "?dialog=1");
  const trigger = page.getByRole("button", { name: "Onboard client" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Onboard client" });
  await expect(dialog).toBeVisible();
  await chooseScope(page);
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await expect(dialog.getByText(/Invitation created/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("heading", { name: "Client Hub" })).toBeVisible();
});

test("closing and reopening keeps an uncertain result instead of creating a second invitation", async ({ page }) => {
  await render(page, "uncertain", "?dialog=1");
  const trigger = page.getByRole("button", { name: "Onboard client" });
  await expect(page.getByRole("link", { name: "Review submissions" })).toHaveAttribute("href", "/administration/client-onboarding");
  await trigger.click();
  await chooseScope(page);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByRole("button", { name: "Create one-time link" }).click();
  await expect(page.getByText(/link result isn't confirmed/i)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await trigger.click();
  await expect(page.getByText(/link result isn't confirmed/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
  expect(await bodies(page, "create")).toHaveLength(1);
  expect(await bodies(page, "reveal")).toHaveLength(1);
});

test("a generic create denial keeps the original invitation reference after reopen", async ({ page }) => {
  await render(page, "create-denied", "?dialog=1");
  const trigger = page.getByRole("button", { name: "Onboard client" });
  const dialog = page.getByRole("dialog");
  await trigger.click();
  await chooseScope(page);
  const sessionReadsBeforeCreate = (await bodies(page, "session")).length;
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const reference = dialog.getByRole("alert").filter({ hasText: "The invitation result isn't confirmed." }).locator("code");
  await expect(reference).toBeVisible();
  await expect.poll(async () => (await bodies(page, "session")).length).toBe(sessionReadsBeforeCreate + 1);
  const issued = await bodies(page, "create");
  expect(issued).toHaveLength(1);
  await expect(reference).toHaveText(String(issued[0]!.commandId));
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(reference).toHaveText(String(issued[0]!.commandId));
  await expect(dialog.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create one-time link" })).toHaveCount(0);
  expect(await bodies(page, "create")).toEqual(issued);
  expect(await bodies(page, "reveal")).toHaveLength(0);
});

test("closing and reopening preserves an uncopied one-time link in memory", async ({ page }) => {
  await render(page, "success", "?dialog=1");
  const trigger = page.getByRole("button", { name: "Onboard client" });
  await trigger.click();
  await chooseScope(page);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByRole("button", { name: "Create one-time link" }).click();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await trigger.click();
  await page.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => (window as Window & { copied?: string[] }).copied?.length)).toBe(1);
  expect(await bodies(page, "create")).toHaveLength(1);
  expect(await bodies(page, "reveal")).toHaveLength(1);
});

test("capability remains hidden when the dedicated administrator session is disabled", async ({ page }) => {
  await render(page, "disabled");
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
});

test("reviewers find pending submissions in the inbox, page through them and open one without copying an ID", async ({ page }) => {
  await render(page);
  const inbox = page.getByRole("region", { name: "Submissions awaiting review" });
  await expect(inbox.getByRole("button", { name: /^Reviewed Client/ })).toBeVisible();
  await expect(inbox.getByRole("button", { name: /^Dana Business/ })).toContainText("Example LLC");
  await inbox.getByRole("button", { name: "Load more submissions" }).click();
  await expect(inbox.getByRole("button", { name: /^Later Client/ })).toContainText("Existing client");
  await expect(inbox.getByRole("button", { name: "Load more submissions" })).toHaveCount(0);
  expect((await bodies(page, "inbox")).map(body => body.cursor)).toEqual([null, { submittedAt: "2098-01-02T00:00:00.000Z", submissionId: businessId }]);
  await openSubmission(page, "Reviewed Client");
  await expect(page).toHaveURL(new RegExp(`\\?submission=${consumerId}$`));
  await expect(page.getByLabel("Submission ID")).toHaveCount(0);
});

test("an email deep link opens that exact submission", async ({ page }) => {
  await render(page, "success", `?submission=${businessId}`);
  await expect(page.getByRole("heading", { name: "Review Dana Business" })).toBeVisible();
  expect((await bodies(page, "review"))[0]).toEqual({ submissionId: businessId });
});

test("a malformed deep link is ignored instead of being sent to the server", async ({ page }) => {
  await render(page, "success", "?submission=../../other");
  await expect(page.getByRole("region", { name: "Submissions awaiting review" })).toBeVisible();
  expect(await bodies(page, "review")).toEqual([]);
});

test("a denied inbox closes every privileged view, including an open review", async ({ page }) => {
  await render(page, "inbox-denied", `?submission=${consumerId}`);
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("access changed");
  await expect(page.locator(".onboarding-inbox-list, .onboarding-review, .onboarding-staff-form")).toHaveCount(0);
});

test("a denied session refresh closes the open review and any revealed link", async ({ page }) => {
  await render(page, "refresh-denied", "", true);
  await chooseScope(page);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByRole("button", { name: "Create one-time link" }).click();
  await expect(page.getByRole("heading", { name: "One-time link ready" })).toBeVisible();
  await openSubmission(page, "Reviewed Client");
  await page.clock.fastForward("08:01");
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.locator(".onboarding-review, .onboarding-secret")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy link" })).toHaveCount(0);
});

test("a transient refresh failure keeps the page open", async ({ page }) => {
  await render(page, "refresh-unavailable", "", true);
  await openSubmission(page, "Reviewed Client");
  await page.clock.fastForward("08:01");
  await expect.poll(async () => (await calls(page)).filter(call => call.path.endsWith("/session")).length).toBe(2);
  await expect(page.getByRole("heading", { name: "Review Reviewed Client" })).toBeVisible();
});

test("the page closes when the verified session deadline passes", async ({ page }) => {
  await render(page, "short-session", "", true);
  await openSubmission(page, "Reviewed Client");
  await page.clock.fastForward("01:01");
  await expect(page.getByRole("alert")).toContainText("session expired");
  await expect(page.locator(".onboarding-review")).toHaveCount(0);
});

for (const mode of ["success", "advancing-session"]) test(`a refreshed token is used without reloading open reviews or inbox pages (${mode})`, async ({ page }) => {
  // advancing-session returns a new bounded deadline on every refresh, so the refresh really changes state.
  await render(page, mode, "", true);
  await page.getByRole("button", { name: "Load more submissions" }).click();
  await openSubmission(page, "Later Client");
  await page.clock.fastForward("08:01");
  await expect.poll(async () => (await calls(page)).filter(call => call.path.endsWith("/session")).length).toBe(2);
  expect(await bodies(page, "inbox")).toHaveLength(2);
  expect(await bodies(page, "review")).toHaveLength(1);
  await expect(page.getByRole("button", { name: /^Later Client/ })).toBeVisible();
});

test("the one-time link can be copied or opened but is never shown on the page", async ({ page }) => {
  await render(page);
  await chooseScope(page);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByRole("button", { name: "Create one-time link" }).click();
  await expect(page.getByRole("heading", { name: "One-time link ready" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("d".repeat(64));
  await expect(page.locator("body")).not.toContainText("portal.example.test");
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  await page.getByRole("button", { name: "Open form in a new tab" }).click();
  await expect(page.getByRole("button", { name: "Open form in this tab" })).toBeVisible();
  const handoff = await page.evaluate(() => { const target = window as Window & { copied?: string[]; opened?: string[] }; return { copied: target.copied, opened: target.opened }; });
  const link = `https://portal.example.test/onboarding/11111111-1111-4111-8111-111111111111#${"d".repeat(64)}`;
  expect(handoff).toEqual({ copied: [link], opened: [link] });
  expect(await bodies(page, "reveal")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Create one-time link" })).toHaveCount(0);
});

test("without a configured link the invitation code can be copied but is not displayed", async ({ page }) => {
  await render(page, "no-link");
  await chooseScope(page);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByRole("button", { name: "Create one-time link" }).click();
  await expect(page.getByRole("heading", { name: "Invitation code ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open form in a new tab" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("d".repeat(64));
  await page.getByRole("button", { name: "Copy invitation code" }).click();
  expect(await page.evaluate(() => (window as Window & { copied?: string[] }).copied)).toEqual(["d".repeat(64)]);
});

test("an uncertain link creation is locked and never repeated", async ({ page }) => {
  await render(page, "uncertain");
  await chooseScope(page);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByRole("button", { name: "Create one-time link" }).click();
  await expect(page.getByRole("alert")).toContainText("The link result isn't confirmed");
  await expect(page.getByRole("button", { name: "Create one-time link" })).toHaveCount(0);
  expect(await bodies(page, "reveal")).toHaveLength(1);
});

test("invitations use named business areas and divisions, never typed IDs", async ({ page }) => {
  await render(page);
  await expect(page.getByLabel(/ID$/)).toHaveCount(0);
  await expect(page.getByText("An existing client record")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create invitation" })).toBeDisabled();
  await page.getByRole("combobox", { name: /^Business area/ }).selectOption({ label: "Technologies" });
  // Only areas that allow it offer the whole-area choice.
  await expect(page.getByRole("combobox", { name: /^Division/ }).locator("option", { hasText: "Whole business area" })).toHaveCount(0);
  await page.getByRole("combobox", { name: /^Division/ }).selectOption({ label: "Web" });
  await page.getByRole("button", { name: "Add business area" }).click();
  await page.getByRole("combobox", { name: /^Business area/ }).nth(1).selectOption({ label: "Drone Services" });
  await page.getByRole("combobox", { name: /^Division/ }).nth(1).selectOption({ label: "Whole business area" });
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByRole("button", { name: "Create one-time link" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Business area/ }).first()).toBeDisabled();
  await expect(page.getByLabel("Link expires")).toBeDisabled();
  expect((await bodies(page, "create"))[0]).toMatchObject({ targetClientRecordId: null,
    scopes: [{ businessAreaId: "area:tech", divisionId: "division:web" }, { businessAreaId: "area:drone", divisionId: null }] });
});

for (const [mode, text] of [["no-scopes", "don't have any business areas"], ["scopes-unavailable", "couldn't be loaded"]] as const) test(`invitations can't be created when business areas are ${mode}`, async ({ page }) => {
  await render(page, mode);
  await expect(page.locator(".onboarding-scopes")).toContainText(text);
  await expect(page.getByRole("button", { name: "Create invitation" })).toBeDisabled();
  expect(await bodies(page, "create")).toEqual([]);
});

test("an individual approved for both businesses shows friendly names and follows activation to active", async ({ page }) => {
  await render(page);
  await openSubmission(page, "Reviewed Client");
  await page.getByLabel("Ledge Top Technologies").check();
  await page.getByLabel("Ledge Top Drone Services").check();
  await expect(page.locator(".onboarding-review")).not.toContainText("project-alpha:");
  await page.getByRole("button", { name: "Approve for Ledge Top Drone Services and Ledge Top Technologies" }).click();
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  expect((await bodies(page, "approve"))[0]).toEqual({ submissionId: consumerId, fieldsSha256: "e".repeat(64), sourceIds: ["project-alpha:primary", "project-alpha:secondary"] });
  await expect(page.locator(".onboarding-inbox-list")).not.toContainText("Reviewed Client");
  await expect(page.locator(".onboarding-activation")).toContainText(/In progress|Portal active/);
  await page.getByRole("button", { name: "Check status now" }).click();
  await expect(page.locator(".onboarding-activation")).toContainText("Portal active");
  await expect(page.locator(".onboarding-activation")).toContainText("Files are still shared separately");
});

test("a business approved as a new company sends the explicit new-company choice", async ({ page }) => {
  await render(page, "business");
  await openSubmission(page, "Dana Business");
  await expect(page.getByLabel(/New company “Example LLC”/)).toBeChecked();
  await page.getByRole("button", { name: "Approve for Operations only" }).click();
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  expect((await bodies(page, "approve"))[0]).toEqual({ submissionId: businessId, fieldsSha256: "e".repeat(64), sourceIds: [], organizationSelection: { kind: "new" } });
});

test("a business can join an exact existing company; unavailable companies can't be chosen", async ({ page }) => {
  await render(page, "business");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByLabel("An existing company in Operations").check();
  await expect(page.getByRole("button", { name: /^Approve for/ })).toBeDisabled();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByLabel(/Example LLC \(old\)/)).toBeDisabled();
  await expect(page.locator(".onboarding-company-picker")).toContainText("This company isn't active.");
  await page.getByLabel(/^Example LLC\s*Ledge Top Drone Services/).check();
  await page.getByRole("button", { name: "Approve for Ledge Top Drone Services" }).click();
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  expect((await bodies(page, "existing-companies"))[0]).toEqual({ submissionId: businessId, sourceIds: ["project-alpha:primary"], query: "Example LLC", afterRecordId: null });
  expect((await bodies(page, "approve"))[0]).toEqual({ submissionId: businessId, fieldsSha256: "e".repeat(64), sourceIds: ["project-alpha:primary"],
    organizationSelection: { kind: "existing", recordId: "org:example", expectedVersion: 4 } });
});

test("a shared company goes through a reviewed plan, locking choices until it is approved or changed", async ({ page }) => {
  await render(page, "shared");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company shared by both businesses").check();
  await expect(page.getByText("Choose at least one business above")).toBeVisible();
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByLabel("Ledge Top Technologies").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel(/^Example LLC/).check();
  await page.getByRole("button", { name: "Review approval plan" }).click();
  const plan = page.getByRole("region", { name: "Approval plan" });
  await expect(plan).toContainText("Ledge Top Drone Services and Ledge Top Technologies");
  await expect(page.getByLabel("Ledge Top Drone Services")).toBeDisabled();
  const [planBody] = await bodies(page, "shared-company-plan");
  expect(planBody).toMatchObject({ submissionId: businessId, fieldsSha256: "e".repeat(64), sourceIds: ["project-alpha:primary", "project-alpha:secondary"],
    organizationSelection: { kind: "shared_existing", groupId: "99999999-9999-4999-8999-999999999999", expectedVersion: 3,
      members: [{ recordId: "org:ltds", expectedVersion: 5 }, { recordId: "org:ltt", expectedVersion: 2 }] } });
  await plan.getByRole("button", { name: "Approve this plan" }).click();
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  expect((await bodies(page, "approve-shared-company"))[0]).toEqual({ planId: planBody!.commandId, submissionId: businessId, fieldsSha256: "e".repeat(64) });
});

test("an uncertain approval locks the choices and retries the identical request", async ({ page }) => {
  await render(page, "uncertain-approval");
  await openSubmission(page, "Reviewed Client");
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Approve for Ledge Top Drone Services" }).click();
  await expect(page.getByRole("alert")).toContainText("isn't confirmed");
  await expect(page.getByLabel("Ledge Top Drone Services")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same approval" }).click();
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  const approvals = await bodies(page, "approve");
  expect(approvals).toHaveLength(2);
  expect(approvals[1]).toEqual(approvals[0]);
});

test("choices are frozen from the moment an approval is sent until it settles", async ({ page }) => {
  await render(page, "delayed-approval");
  await openSubmission(page, "Reviewed Client");
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Approve for Ledge Top Drone Services" }).click();
  await expect(page.getByRole("button", { name: "Approving…" })).toBeDisabled();
  await expect(page.getByLabel("Ledge Top Drone Services")).toBeDisabled();
  await expect(page.getByLabel("Ledge Top Technologies")).toBeDisabled();
  await page.getByLabel("Ledge Top Technologies").dispatchEvent("click");
  await expect(page.getByLabel("Ledge Top Technologies")).not.toBeChecked();
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  expect(await bodies(page, "approve")).toEqual([{ submissionId: consumerId, fieldsSha256: "e".repeat(64), sourceIds: ["project-alpha:primary"] }]);
});

test("business, company mode and shared company are frozen while a plan is being prepared", async ({ page }) => {
  await render(page, "delayed-plan");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company shared by both businesses").check();
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel(/^Example LLC/).check();
  await page.getByRole("button", { name: "Review approval plan" }).click();
  await expect(page.getByRole("button", { name: "Preparing…" })).toBeDisabled();
  for (const label of ["Ledge Top Drone Services", "Ledge Top Technologies", /^New company/, "An existing company in Operations"] as const)
    await expect(page.getByLabel(label, { exact: typeof label === "string" })).toBeDisabled();
  await expect(page.getByLabel(/^Example LLC/)).toBeDisabled();
  await expect(page.getByLabel("Search shared companies")).toBeDisabled();
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await expect(page.getByRole("region", { name: "Approval plan" })).toBeVisible();
  const plans = await bodies(page, "shared-company-plan");
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ sourceIds: ["project-alpha:primary"] });
  await expect(page.getByLabel("Ledge Top Drone Services")).toBeDisabled();
});

const sessionReads = async (page: Page) => (await calls(page)).filter(call => call.path.endsWith("/session")).length;

for (const mode of ["choices-denied", "status-denied"]) test(`a ${mode.split("-")[0]} refusal closes the review instead of offering an Operations-only approval`, async ({ page }) => {
  await render(page, mode, `?submission=${consumerId}`);
  await expect(page.getByRole("alert").filter({ hasText: "outside your review access" })).toBeVisible();
  await expect(page.locator(".onboarding-review")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("client@example.test");
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  // The refusal re-verifies the session; it is still valid, so the rest of the page stays.
  await expect.poll(() => sessionReads(page)).toBe(2);
  await expect(page.getByRole("region", { name: "Submissions awaiting review" })).toBeVisible();
});

test("businesses that can't be checked block approval until checked again", async ({ page }) => {
  await render(page, "choices-unavailable", `?submission=${consumerId}`);
  await expect(page.getByRole("alert")).toContainText("can't be approved yet");
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("button", { name: "Approve for Operations only" })).toBeVisible();
  expect(await sessionReads(page)).toBe(1);
});

test("a disabled capability on any read closes the whole page", async ({ page }) => {
  await render(page, "review-disabled", `?submission=${consumerId}`);
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.locator(".onboarding-inbox, .onboarding-staff-form")).toHaveCount(0);
});

test("a refused approval releases the choices and re-verifies the session", async ({ page }) => {
  await render(page, "approve-denied");
  await openSubmission(page, "Reviewed Client");
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Approve for Ledge Top Drone Services" }).click();
  await expect(page.getByRole("alert")).toContainText("Approval was refused");
  await expect(page.getByLabel("Ledge Top Drone Services")).toBeEnabled();
  await expect.poll(() => sessionReads(page)).toBe(2);
  await expect(page.getByRole("heading", { name: "Review Reviewed Client" })).toBeVisible();
});

test("a refused approval after the staff session was revoked closes everything", async ({ page }) => {
  await render(page, "approve-revoked");
  await openSubmission(page, "Reviewed Client");
  await page.getByRole("button", { name: "Approve for Operations only" }).click();
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.locator(".onboarding-review, .onboarding-inbox")).toHaveCount(0);
});

test("a refused company search re-verifies the session", async ({ page }) => {
  await render(page, "search-denied");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company in Operations").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Companies couldn't be searched");
  await expect.poll(() => sessionReads(page)).toBe(2);
});

test("a refused page of company results withdraws the earlier results and the chosen company", async ({ page }) => {
  await render(page, "search-page-denied");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company in Operations").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel(/^Example LLC\s*Ledge Top Drone Services/).check();
  await page.getByRole("button", { name: "Load more companies" }).click();
  await expect(page.getByRole("alert")).toContainText("Companies couldn't be searched");
  await expect(page.locator(".onboarding-company-picker input[type=radio]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Approve for/ })).toBeDisabled();
  // The session is still valid, so the review itself stays; a fresh search is required.
  await expect.poll(() => sessionReads(page)).toBe(2);
  await expect(page.getByRole("heading", { name: "Review Dana Business" })).toBeVisible();
  expect(await bodies(page, "approve")).toEqual([]);
});

test("a refused page of shared companies withdraws the earlier results and the chosen company", async ({ page }) => {
  await render(page, "shared-page-denied");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company shared by both businesses").check();
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel(/^Example LLC/).check();
  await page.getByRole("button", { name: "Load more companies" }).click();
  await expect(page.getByRole("alert")).toContainText("Shared companies couldn't be searched");
  await expect(page.getByLabel(/^Example LLC/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review approval plan" })).toBeDisabled();
  await expect.poll(() => sessionReads(page)).toBe(2);
  expect(await bodies(page, "shared-company-plan")).toEqual([]);
});

for (const kind of ["existing", "shared"]) test(`a late ${kind} company search refusal can't close a newly opened review`, async ({ page }) => {
  await render(page, "late-search-404");
  await openSubmission(page, "Dana Business");
  await page.getByLabel(kind === "existing" ? "An existing company in Operations" : "An existing company shared by both businesses").check();
  if (kind === "shared") await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Searching…" })).toBeVisible();
  await openSubmission(page, "Reviewed Client");
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await page.waitForTimeout(200);
  await expect(page.getByRole("heading", { name: "Review Reviewed Client" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toHaveCount(0);
  expect(await sessionReads(page)).toBe(1);
});

test("changing businesses during a shared search leaves search and planning usable", async ({ page }) => {
  await render(page, "held-shared-search");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company shared by both businesses").check();
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Searching…" })).toBeVisible();
  await page.getByLabel("Ledge Top Technologies").check();
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  // The superseded reply is dropped, and the search is usable again for the new businesses.
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await expect(page.getByLabel(/^Example LLC/)).toHaveCount(0);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel(/^Example LLC/).check();
  await page.getByRole("button", { name: "Review approval plan" }).click();
  await expect(page.getByRole("region", { name: "Approval plan" })).toBeVisible();
  const searches = await bodies(page, "shared-company-choices");
  expect(searches.map(body => body.sourceIds)).toEqual([["project-alpha:primary"], ["project-alpha:primary", "project-alpha:secondary"]]);
  expect((await bodies(page, "shared-company-plan"))[0]).toMatchObject({ sourceIds: ["project-alpha:primary", "project-alpha:secondary"] });
});

test("a refusal during an in-flight session check forces one fresh check afterwards", async ({ page }) => {
  await render(page, "deferred-recheck", "", true);
  await openSubmission(page, "Reviewed Client");
  await page.clock.fastForward("08:01");
  await expect.poll(() => sessionReads(page)).toBe(2);
  await page.getByRole("button", { name: "Approve for Operations only" }).click();
  await expect(page.getByRole("alert")).toContainText("Approval was refused");
  // The earlier check was authorized before the refusal; its success must not settle it.
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await expect.poll(() => sessionReads(page)).toBe(3);
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.locator(".onboarding-review")).toHaveCount(0);
});

for (const mode of ["poll-null", "poll-transient"]) test(`activation polling continues after ${mode === "poll-null" ? "an empty" : "a failed"} read until active`, async ({ page }) => {
  await render(page, mode, `?submission=${consumerId}`, true);
  await page.getByRole("button", { name: "Approve for Operations only", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approved", exact: true })).toBeVisible();
  await page.clock.runFor(1);
  await expect.poll(async () => (await bodies(page, "activation-status")).length).toBe(2);
  for (let i = 0; i < 3; i++) { await page.clock.runFor(10_001); await page.evaluate(() => Promise.resolve()); }
  await expect(page.locator(".onboarding-activation")).toContainText("Portal active", { timeout: 1000 });
  expect((await bodies(page, "activation-status")).length).toBeGreaterThanOrEqual(mode === "poll-null" ? 4 : 3);
});

test("a refused activation read stops polling and re-verifies the session", async ({ page }) => {
  await render(page, "activation-denied", `?submission=${consumerId}`, true);
  await page.getByRole("button", { name: "Approve for Operations only", exact: true }).click();
  await expect(page.locator(".onboarding-approval-success")).toContainText("outside your access");
  const reads = (await bodies(page, "activation-status")).length;
  await page.clock.runFor(60_000);
  expect((await bodies(page, "activation-status")).length).toBe(reads);
  await expect(page.getByRole("button", { name: "Check status now" })).toHaveCount(0);
  await expect.poll(() => sessionReads(page)).toBe(2);
});

test("an already reviewed submission shows its activation instead of approval controls", async ({ page }) => {
  await render(page, "decided", `?submission=${consumerId}`);
  await expect(page.getByRole("heading", { name: "Already reviewed" })).toBeVisible();
  await expect(page.locator(".onboarding-activation")).toContainText("Portal active");
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
});

test("existing-client submissions explain that this review can't approve them", async ({ page }) => {
  await render(page);
  await page.getByRole("button", { name: "Load more submissions" }).click();
  await openSubmission(page, "Later Client");
  await expect(page.getByText("This submission updates an existing client")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
});

for (const width of [320, 768, 1440]) test(`onboarding review fits ${width}px without horizontal scrolling`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await render(page, "shared");
  await openSubmission(page, "Dana Business");
  await page.getByLabel("An existing company shared by both businesses").check();
  await page.getByLabel("Ledge Top Drone Services").check();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByLabel(/^Example LLC/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

async function prepareExpiringInvitation(page: Page, mode: string) {
  await render(page, mode, "?dialog=1", true);
  await page.getByRole("button", { name: "Onboard client" }).click();
  const dialog = page.getByRole("dialog", { name: "Onboard client" });
  await chooseScope(page);
  const localExpiry = await page.evaluate(() => {
    const end = new Date(Date.now() + 3 * 60_000);
    const local = new Date(end.getTime() - end.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  });
  await dialog.getByLabel("Link expires").fill(localExpiry);
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const reveal = dialog.getByRole("button", { name: "Create one-time link" });
  await expect(reveal).toBeEnabled();
  const [create] = await bodies(page, "create");
  return { dialog, reveal, create: create!, expiresAt: new Date(create!.expiresAt as string).getTime() };
}

const copiedAndOpened = (page: Page) => page.evaluate(() => {
  const fixture = window as Window & { copied?: string[]; opened?: string[] };
  return { copies: fixture.copied?.length ?? 0, opens: fixture.opened?.length ?? 0 };
});

for (const closed of [false, true]) {
  test(`expired invitation loses copy and open actions while ${closed ? "closed" : "open"}`, async ({ page }) => {
    const { dialog, reveal, create } = await prepareExpiringInvitation(page, "invitation-expiry");
    await reveal.click();
    await expect(dialog.getByRole("heading", { name: "One-time link ready" })).toBeVisible();
    await expect.poll(() => copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
    if (closed) await dialog.getByRole("button", { name: "Close" }).click();
    await page.clock.fastForward(4 * 60_000);
    if (closed) await page.getByRole("button", { name: "Onboard client" }).click();
    await expect(dialog.getByText("This invitation has expired.", { exact: false })).toBeVisible();
    await expect(dialog.getByText(String(create.commandId), { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^(Copy link|Open form|Create one-time link|Generate and Copy|Create invitation)/ })).toHaveCount(0);
    expect(await copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
    expect(await bodies(page, "create")).toEqual([create]);
    expect(await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
  });
}

for (const action of ["Copy link", "Open form in a new tab"]) {
  test(`expired invitation blocks ${action} before its timer fires`, async ({ page }) => {
    const { dialog, reveal, expiresAt } = await prepareExpiringInvitation(page, "invitation-expiry");
    await reveal.click();
    const button = dialog.getByRole("button", { name: action });
    await expect(button).toBeVisible();
    await expect.poll(() => copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
    const stale = await button.elementHandle();
    await page.clock.setSystemTime(expiresAt + 1);
    await stale!.evaluate(element => (element as HTMLButtonElement).click());
    await expect(dialog.getByText("This invitation has expired.", { exact: false })).toBeVisible();
    expect(await copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
    expect(await bodies(page, "create")).toHaveLength(1);
    expect(await bodies(page, "reveal")).toHaveLength(1);
  });
}

test("reveal arriving after expiry offers no link or clipboard write", async ({ page }) => {
  const { dialog, reveal, create, expiresAt } = await prepareExpiringInvitation(page, "invitation-expiry-delayed");
  await reveal.click();
  await expect.poll(async () => await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
  await page.clock.setSystemTime(expiresAt + 1);
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();
  await expect(dialog.getByText("This invitation has expired.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "One-time link ready" })).toHaveCount(0);
  expect(await copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
  expect(await bodies(page, "create")).toEqual([create]);
  expect(await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
});

test("reveal with mismatching expiry stays uncertain without another create or reveal", async ({ page }) => {
  const { dialog, reveal, create } = await prepareExpiringInvitation(page, "invitation-expiry-mismatch");
  await reveal.click();
  await expect(dialog.getByText("The link result isn't confirmed.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Onboard client" }).click();
  await expect(dialog.getByText("The link result isn't confirmed.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^(Copy link|Open form|Create one-time link|Generate and Copy|Create invitation)/ })).toHaveCount(0);
  expect(await copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
  expect(await bodies(page, "create")).toEqual([create]);
  expect(await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
});

test("latched expiry survives a backward clock step before the reveal reply", async ({ page }) => {
  const { dialog, reveal, create, expiresAt } = await prepareExpiringInvitation(page, "invitation-expiry-delayed");
  await reveal.click();
  await expect.poll(async () => await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
  await page.clock.fastForward(4 * 60_000);
  await expect(dialog.getByText("This invitation has expired.", { exact: false })).toBeVisible();
  await page.clock.setSystemTime(expiresAt - 30_000);
  await page.evaluate(() => (window as Window & { release?: () => void }).release?.());
  await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();
  await expect(dialog.getByText("This invitation has expired.", { exact: false })).toBeVisible();
  await expect(dialog.getByText(String(create.commandId), { exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "One-time link ready" })).toHaveCount(0);
  expect(await copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
  expect(await bodies(page, "create")).toEqual([create]);
  expect(await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
});

test("legacy reveal with a different link fragment only offers the validated manual code", async ({ page }) => {
  const { dialog, reveal, create } = await prepareExpiringInvitation(page, "legacy-mismatched-link");
  await reveal.click();
  await expect(dialog.getByRole("heading", { name: "Invitation code ready" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^(Copy link|Open form|Create one-time link)/ })).toHaveCount(0);
  expect(await copiedAndOpened(page)).toEqual({ copies: 0, opens: 0 });
  await dialog.getByRole("button", { name: "Copy invitation code" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { copied?: string[] }).copied)).toEqual(["d".repeat(64)]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Onboard client" }).click();
  await expect(dialog.getByRole("heading", { name: "Invitation code ready" })).toBeVisible();
  expect(await copiedAndOpened(page)).toEqual({ copies: 1, opens: 0 });
  expect(await bodies(page, "create")).toEqual([create]);
  expect(await bodies(page, "reveal")).toEqual([{ commandId: create.commandId }]);
});
