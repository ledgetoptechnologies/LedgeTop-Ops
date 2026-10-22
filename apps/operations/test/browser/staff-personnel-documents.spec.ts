import { expect, test, type Page, type Request } from "@playwright/test";

// Synthetic people and files only. The mock follows docs/operations/staff-personnel-documents.md.
const CSRF = "a".repeat(64);
const ALL = ["staff.documents.read", "staff.documents.upload", "staff.documents.manage", "staff.profile.archive", "staff.profile.restore"];
const retention = (version = 1, hold = false, reviewAfter: string | null = null) => ({ hold, reviewAfter, reviewNote: "", version });
const doc = (id: string, filename: string, category: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, staffId: "staff-jamie", filename, category, contentType: "application/pdf", size: 120_000, status, createdAt: "2026-10-01T15:00:00Z", retention: retention(), ...extra,
});

type Options = { admin?: boolean; capabilities?: string[]; disabled?: boolean; uploadFailures?: Array<{ status: number; error: string }> };

async function setup(page: Page, options: Options = {}) {
  const state = {
    profile: { archived_at: null as string | null, version: 3 },
    documents: [
      doc("11111111-1111-4111-8111-111111111111", "Noncompete 2026.pdf", "agreement", "accepted", { retention: retention(2, true, "2031-01-15") }),
      doc("22222222-2222-4222-8222-222222222222", "W-4.pdf", "tax", "quarantined"),
      doc("33333333-3333-4333-8333-333333333333", "scan.pdf", "onboarding", "rejected"),
      doc("44444444-4444-4444-8444-444444444444", "partial.pdf", "other", "uploading"),
      doc("55555555-5555-4555-8555-555555555555", "I-9.pdf", "onboarding", "quarantined", { scan: { state: "manual_review", attempts: 8, retryAfter: null, errorCode: "attempts_exhausted" } }),
      doc("66666666-6666-4666-8666-666666666666", "Handbook.pdf", "other", "quarantined", { scan: { state: "pending", attempts: 2, retryAfter: "2026-10-22T20:15:00Z", errorCode: "scan_unavailable" } }),
      doc("77777777-7777-4777-8777-777777777777", "Direct deposit.pdf", "tax", "quarantined", { scan: { state: "leased", attempts: 1, retryAfter: null, errorCode: null } }),
    ],
    uploads: [] as Array<{ headers: Record<string, string>; size: number }>,
    posts: [] as Array<{ path: string; body: any; headers: Record<string, string> }>,
    other: [] as string[],
    failures: [...(options.uploadFailures ?? [])],
  };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin Person", status: "Active", profileType: "Administrator",
        isAdministrator: options.admin !== false, permissions: ["team.view", "dashboard.view"], divisions: [] },
      csrfToken: "ops-csrf", timezone: "America/Chicago", capabilities: {},
    } });
    if (path === "/api/team/staff") return route.fulfill({ json: { staff: [
      { id: "staff-admin", display_name: "Admin Person", email: "admin@example.test", status: "active", roles: "Owner", localControls: {} },
      { id: "staff-jamie", display_name: "Jamie Rivera", email: "jamie@example.test", status: "active", roles: "Pilot", localControls: {} },
    ] } });
    if (!path.startsWith("/api/staff-personnel/")) { if (request.method() !== "GET") state.other.push(`${request.method()} ${path}`); return route.fulfill({ status: 404, json: { error: "not_found" } }); }
    const headers = request.headers();
    if (headers["x-personnel-request"] !== "1") return route.fulfill({ status: 403, json: { error: "personnel_denied" } });
    if (options.disabled) return route.fulfill({ status: 404, json: { error: "not_found" } });
    const base = /^\/api\/staff-personnel\/profiles\/([^/]+)/.exec(path)![1];
    const rest = path.slice(`/api/staff-personnel/profiles/${base}`.length);
    if (request.method() === "GET" && rest === "/session") return route.fulfill({ json: { csrfToken: CSRF, verifiedUntil: "2030-01-01T00:00:00Z", capabilities: options.capabilities ?? ALL } });
    if (request.method() === "GET" && rest === "/documents") return route.fulfill({ json: { profile: state.profile, documents: state.documents } });
    if (request.method() === "GET" && rest.endsWith("/content")) {
      return route.fulfill({ status: 200, body: "%PDF-1.7 synthetic", headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"document\"" } });
    }
    if (request.method() !== "POST" || headers["x-csrf-token"] !== CSRF) return route.fulfill({ status: 403, json: { error: "personnel_denied" } });
    if (rest === "/documents") {
      state.uploads.push({ headers, size: request.postDataBuffer()?.length ?? 0 });
      const failure = state.failures.shift();
      if (failure) return route.fulfill({ status: failure.status, json: { error: failure.error } });
      const created = { ...doc(headers["idempotency-key"]!, decodeURIComponent(headers["x-file-name"]!), headers["x-document-category"]!, "quarantined"), size: request.postDataBuffer()!.length };
      if (!state.documents.some(item => item.id === created.id)) state.documents.unshift(created);
      return route.fulfill({ status: 201, json: { document: created, replayed: false } });
    }
    const body = JSON.parse(request.postData() || "{}");
    state.posts.push({ path: rest, body, headers });
    if (rest.endsWith("/retention")) {
      const item = state.documents.find(entry => rest.includes(entry.id))!;
      if (body.expectedVersion !== item.retention.version) return route.fulfill({ status: 409, json: { error: "version_conflict" } });
      item.retention = { hold: body.hold, reviewAfter: body.reviewAfter, reviewNote: body.reviewNote, version: item.retention.version + 1 };
      return route.fulfill({ json: { version: item.retention.version, replayed: false } });
    }
    if (rest === "/archive" || rest === "/restore") {
      if (body.expectedVersion !== state.profile.version) return route.fulfill({ status: 409, json: { error: "version_conflict" } });
      state.profile = { archived_at: rest === "/archive" ? "2026-10-22T18:00:00Z" : null, version: state.profile.version + 1 };
      return route.fulfill({ json: { version: state.profile.version, archived: rest === "/archive", admissionRestored: false, replayed: false } });
    }
    return route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
  });
  await page.goto("/team");
  return state;
}

const jamieCard = (page: Page) => page.locator(".ltds-card").filter({ hasText: "Jamie Rivera" });
async function openJamie(page: Page) {
  await jamieCard(page).getByRole("button", { name: "Documents" }).click();
  const dialog = page.getByRole("dialog", { name: "Documents · Jamie Rivera" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("documents are grouped by type and show their scan state honestly, with no delete", async ({ page }) => {
  await setup(page);
  const dialog = await openJamie(page);
  for (const heading of ["Agreement or noncompete", "Tax form (W-4, W-9, 1099)", "Onboarding", "Other"])
    await expect(dialog.getByRole("heading", { name: heading })).toBeVisible();
  const row = (name: string) => dialog.locator(".personnel-document").filter({ hasText: name });
  await expect(row("Noncompete 2026.pdf")).toContainText("Ready");
  await expect(row("Noncompete 2026.pdf")).toContainText("On hold");
  await expect(row("Noncompete 2026.pdf")).toContainText(/Review after Jan 15, 2031/);
  await expect(row("Noncompete 2026.pdf").getByRole("button", { name: "Download" })).toBeVisible();
  await expect(row("W-4.pdf")).toContainText("Waiting for virus scan");
  await expect(row("scan.pdf")).toContainText("Blocked by virus scan");
  await expect(row("partial.pdf")).toContainText("Upload not finished");
  await expect(row("I-9.pdf")).toContainText("Scan needs attention");
  await expect(row("I-9.pdf")).toContainText("couldn't finish after several tries");
  await expect(row("Handbook.pdf")).toContainText("Scan will retry");
  await expect(row("Handbook.pdf")).toContainText("it will try again after");
  await expect(row("Direct deposit.pdf")).toContainText("Scanning now");
  await expect(row("I-9.pdf")).not.toContainText("attempts_exhausted");
  for (const locked of ["W-4.pdf", "scan.pdf", "partial.pdf", "I-9.pdf", "Handbook.pdf", "Direct deposit.pdf"]) await expect(row(locked).getByRole("button", { name: "Download" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /delete|remove/i })).toHaveCount(0);
});

test("an upload sends the file only to the private personnel route with its own protections", async ({ page }) => {
  const state = await setup(page);
  const dialog = await openJamie(page);
  await dialog.getByLabel("Type").selectOption("tax");
  await dialog.getByLabel("File").setInputFiles({ name: "1099 – 2025.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 synthetic %%EOF") });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog.getByRole("status")).toContainText("1099 – 2025.pdf was uploaded. It stays locked until the virus scan finishes.");
  await expect(dialog.locator(".personnel-document").filter({ hasText: "1099 – 2025.pdf" })).toContainText("Waiting for virus scan");
  expect(state.uploads).toHaveLength(1);
  const sent = state.uploads[0]!.headers;
  expect(sent["x-personnel-request"]).toBe("1");
  expect(sent["x-csrf-token"]).toBe(CSRF);
  expect(sent["x-csrf-token"]).not.toBe("ops-csrf");
  expect(sent["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(sent["x-file-name"]).toBe(encodeURIComponent("1099 – 2025.pdf"));
  expect(sent["x-document-category"]).toBe("tax");
  expect(sent["content-type"]).toBe("application/pdf");
  expect(state.other).toEqual([]);
});

test("an uncertain upload failure retries with the same request; a definite refusal does not", async ({ page }) => {
  const state = await setup(page, { uploadFailures: [{ status: 503, error: "personnel_unavailable" }, { status: 415, error: "unsupported_document" }] });
  const dialog = await openJamie(page);
  await dialog.getByLabel("Type").selectOption("agreement");
  await dialog.getByLabel("File").setInputFiles({ name: "offer.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 x %%EOF") });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog.getByRole("alert")).toContainText("unavailable right now");
  await expect(dialog.getByLabel("File")).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry upload" }).click();
  await expect(dialog.getByRole("alert")).toContainText("file type isn't accepted");
  await expect(dialog.getByRole("button", { name: "Retry upload" })).toHaveCount(0);
  expect(state.uploads).toHaveLength(2);
  expect(state.uploads[1]!.headers["idempotency-key"]).toBe(state.uploads[0]!.headers["idempotency-key"]);
  await expect(dialog.getByLabel("File")).toBeEnabled();
});

test("files that can't be accepted are stopped before upload", async ({ page }) => {
  const state = await setup(page);
  const dialog = await openJamie(page);
  await dialog.getByLabel("Type").selectOption("other");
  await dialog.getByLabel("File").setInputFiles({ name: "notes.html", mimeType: "text/html", buffer: Buffer.from("<b>x</b>") });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Use PDF, JPG, PNG, DOCX, XLSX or TXT");
  await dialog.getByLabel("File").setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog.getByRole("alert")).toContainText("over 25 MB");
  expect(state.uploads).toHaveLength(0);
});

test("download fetches with the personnel header and saves under the real name", async ({ page }) => {
  await setup(page);
  const dialog = await openJamie(page);
  const requests: Request[] = [];
  page.on("request", request => { if (request.url().includes("/content")) requests.push(request); });
  const [download] = await Promise.all([page.waitForEvent("download"),
    dialog.locator(".personnel-document").filter({ hasText: "Noncompete 2026.pdf" }).getByRole("button", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe("Noncompete 2026.pdf");
  expect(requests[0]!.headers()["x-personnel-request"]).toBe("1");
});

test("retention needs a note and saves against the current version; a conflict refreshes", async ({ page }) => {
  const state = await setup(page);
  const dialog = await openJamie(page);
  await dialog.locator(".personnel-document").filter({ hasText: "W-4.pdf" }).getByRole("button", { name: "Retention" }).click();
  const editor = page.getByRole("dialog", { name: "Retention" });
  await editor.getByLabel(/Place on hold/).check();
  await editor.getByLabel(/Review after/).fill("2030-04-15");
  await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();
  await editor.getByLabel(/Note/).fill("Keep during audit");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("status")).toContainText("Retention for W-4.pdf was saved.");
  expect(state.posts[0]!.body).toMatchObject({ expectedVersion: 1, hold: true, reviewAfter: "2030-04-15", reviewNote: "Keep during audit" });
  expect(state.posts[0]!.body.commandId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(dialog.locator(".personnel-document").filter({ hasText: "W-4.pdf" })).toContainText("On hold");
  // Someone else changed it meanwhile: the panel refreshes and says so.
  state.documents.find(item => item.filename === "scan.pdf")!.retention.version = 9;
  await dialog.locator(".personnel-document").filter({ hasText: "scan.pdf" }).getByRole("button", { name: "Retention" }).click();
  await page.getByRole("dialog", { name: "Retention" }).getByLabel(/Note/).fill("Review");
  state.documents.find(item => item.filename === "scan.pdf")!.retention.version = 10;
  await page.getByRole("dialog", { name: "Retention" }).getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Someone else changed this record");
});

test("archiving keeps records and turns off sign-in; restoring does not turn sign-in back on", async ({ page }) => {
  const state = await setup(page);
  const dialog = await openJamie(page);
  await dialog.getByRole("button", { name: "Archive employee…" }).click();
  const confirm = page.getByRole("dialog", { name: "Archive Jamie Rivera?" });
  await expect(confirm.getByRole("button", { name: "Archive employee" })).toBeDisabled();
  await confirm.getByLabel(/Reason/).fill("Left the company on Oct 31");
  await confirm.getByRole("button", { name: "Archive employee" }).click();
  await expect(dialog.getByRole("status").first()).toContainText("Archived former employee");
  await expect(dialog.getByRole("heading", { name: "Add a document" })).toHaveCount(0);
  await expect(dialog.locator(".personnel-document").filter({ hasText: "Noncompete 2026.pdf" }).getByRole("button", { name: "Download" })).toBeVisible();
  expect(state.posts.at(-1)).toMatchObject({ path: "/archive", body: { expectedVersion: 3, reason: "Left the company on Oct 31" } });
  await dialog.getByRole("button", { name: "Restore profile…" }).click();
  const restore = page.getByRole("dialog", { name: "Restore Jamie Rivera?" });
  await expect(restore).toContainText("does not turn their sign-in back on");
  await restore.getByLabel(/Reason/).fill("Rehired");
  await restore.getByRole("button", { name: "Restore profile" }).click();
  await expect(dialog.getByText(/sign-in is still off until access is turned on separately/)).toBeVisible();
  expect(state.posts.at(-1)).toMatchObject({ path: "/restore", body: { expectedVersion: 4, reason: "Rehired" } });
});

test("controls follow the person's actual capabilities, and nobody can archive themselves", async ({ page }) => {
  await setup(page, { capabilities: ["staff.documents.read"] });
  let dialog = await openJamie(page);
  await expect(dialog.getByRole("heading", { name: "Add a document" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Retention" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Archive/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Download" })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.locator(".ltds-card").filter({ hasText: "admin@example.test" }).getByRole("button", { name: "Documents" }).click();
  dialog = page.getByRole("dialog", { name: "Documents · Admin Person" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Archive/ })).toHaveCount(0);
});

test("non-administrators see no Documents button; a disabled feature explains itself", async ({ page }) => {
  await setup(page, { admin: false });
  await expect(jamieCard(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Documents" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setup(page, { disabled: true });
  const dialog = await openJamie(page);
  await expect(dialog.getByRole("alert")).toContainText("aren't turned on yet");
});

test("the panel fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setup(page);
  const dialog = await openJamie(page);
  await expect(dialog.getByRole("heading", { name: "Add a document" })).toBeVisible();
  const overflow = await dialog.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
