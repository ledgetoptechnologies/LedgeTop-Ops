import { expect, test } from "@playwright/test";
import { incomingRequestPage } from "../../src/worker/incoming-page";

const incomingUrl = "http://127.0.0.1:4174/incoming-test";
const incomingOrigin = "http://127.0.0.1:4174";
const r2Url = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/incoming/object?uploadId=upload-1&partNumber=1";

test("incoming page keeps protected access and compact Turnstile/drop content inside a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.route(incomingUrl, route => route.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com" }, body: incomingRequestPage({ publicId: "request-a", title: "A saved request title", turnstileSiteKey: "site", requiresAccessCode: true }) }));
  await page.route("**/api/public/requests/request-a/authorize", route => route.fulfill({ json: { ok: true } }));
  await page.goto(incomingUrl);
  await expect(page.getByRole("heading", { name: "A saved request title" })).toBeVisible();
  await expect(page.getByLabel("Access code")).toHaveAttribute("required", "");
  const widget = page.locator(".cf-turnstile");
  const widgetBox = await widget.boundingBox();
  const panelBox = await page.locator(".panel").boundingBox();
  expect(widgetBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(widgetBox!.width).toBeLessThanOrEqual(150);
  expect(Math.abs((widgetBox!.x + widgetBox!.width / 2) - (panelBox!.x + panelBox!.width / 2))).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await widget.evaluate(element => { element.textContent = "Turnstile verification"; });
  await page.screenshot({ path: testInfo.outputPath("incoming-mobile-identity-widget.png"), fullPage: true });
  await page.getByLabel("Your name").fill("Client Tester");
  await page.getByLabel("Email").fill("client@example.test");
  await page.getByLabel("Access code").fill("code");
  await page.getByRole("button", { name: "Continue securely" }).click();
  const drop = page.locator("#drop"), help = page.locator("#drop-help");
  await expect(drop).toBeVisible();
  await expect(help).toBeVisible();
  const [dropBox, helpBox] = await Promise.all([drop.boundingBox(), help.boundingBox()]);
  expect(dropBox).not.toBeNull();
  expect(helpBox).not.toBeNull();
  expect(helpBox!.x).toBeGreaterThanOrEqual(dropBox!.x);
  expect(helpBox!.x + helpBox!.width).toBeLessThanOrEqual(dropBox!.x + dropBox!.width + 1);
});

test("incoming page sends file bytes only to R2 and completes through checkpoints", async ({ page }, testInfo) => {
  const source = Buffer.from("safe-photo-bytes");
  const workerBodies: Buffer[] = [];
  let r2Body: Buffer | null = null;

  await page.route(incomingUrl, route => route.fulfill({
    status: 200,
    contentType: "text/html",
    headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com" },
    body: incomingRequestPage({ publicId: "request-a", title: "Upload files", requiresAccessCode: false }),
  }));
  await page.route("**/api/public/requests/request-a/**", async route => {
    const request = route.request();
    const body = request.postDataBuffer();
    if (body) workerBodies.push(body);
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/authorize")) return route.fulfill({ json: { ok: true } });
    if (path.endsWith("/files/init")) return route.fulfill({ json: { fileId: "file-1", partSize: source.length, status: "uploading", completedParts: [] } });
    if (path.endsWith("/part-ticket")) return route.fulfill({ json: { url: r2Url, expiresIn: 300, partNumber: 1, contentLength: source.length, contentType: "image/jpeg" } });
    if (path.endsWith("/parts/1")) return route.fulfill({ json: { ok: true, partNumber: 1, etag: "1".repeat(32) } });
    if (path.endsWith("/complete")) return route.fulfill({ json: { ok: true, status: "quarantined" } });
    return route.fulfill({ status: 404, json: { message: "not found" } });
  });
  await page.route("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": incomingOrigin, "Access-Control-Allow-Methods": "PUT,OPTIONS" } });
    r2Body = route.request().postDataBuffer();
    expect(route.request().headers().cookie).toBeUndefined();
    await route.fulfill({ status: 200, headers: { ETag: `"${"1".repeat(32)}"`, "Access-Control-Allow-Origin": incomingOrigin, "Access-Control-Expose-Headers": "ETag" } });
  });

  await page.goto(incomingUrl);
  await page.screenshot({ path: testInfo.outputPath("incoming-desktop-identity.png"), fullPage: true });
  const panel = page.locator(".panel");
  const continueButton = page.getByRole("button", { name: "Continue securely" });
  const panelBox = await panel.boundingBox();
  const continueBox = await continueButton.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(continueBox).not.toBeNull();
  expect(Math.abs((continueBox!.x + continueBox!.width / 2) - (panelBox!.x + panelBox!.width / 2))).toBeLessThan(2);
  await page.getByLabel("Your name").fill("Client Tester");
  await page.getByLabel("Email").fill("client@example.test");
  await continueButton.click();
  const drop = page.locator("#drop");
  await expect(drop).toBeVisible();
  const dropBox = await drop.boundingBox();
  expect(dropBox).not.toBeNull();
  expect(dropBox!.width).toBeGreaterThan(200);
  expect(dropBox!.height).toBeGreaterThan(150);
  await page.locator("#files").setInputFiles({ name: "very-long-client-upload-filename-that-must-wrap-without-overflowing-the-incoming-upload-panel-photo.jpg", mimeType: "image/jpeg", buffer: source });
  await expect(page.getByText("Uploaded successfully", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("incoming-upload-long-filename.png"), fullPage: true });
  expect(r2Body).toEqual(source);
  expect(workerBodies.some(body => body.equals(source))).toBe(false);
  expect(JSON.parse(workerBodies.find(body => body.toString().includes("resumeFingerprint"))!.toString()).resumeFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("incoming page cancels an in-flight direct upload and clears its saved resume", async ({ page }) => {
  let cancelCalls = 0;
  await page.route(incomingUrl, route => route.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com" }, body: incomingRequestPage({ publicId: "request-a", title: "Upload files", requiresAccessCode: false }) }));
  await page.route("**/api/public/requests/request-a/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE") { cancelCalls += 1; return route.fulfill({ json: { ok: true, status: "cancelled" } }); }
    if (path.endsWith("/authorize")) return route.fulfill({ json: { ok: true } });
    if (path.endsWith("/files/init")) return route.fulfill({ json: { fileId: "file-1", partSize: 64, status: "uploading", completedParts: [] } });
    if (path.endsWith("/part-ticket")) return route.fulfill({ json: { url: r2Url, expiresIn: 300, partNumber: 1, contentLength: 64, contentType: "application/pdf" } });
    return route.fulfill({ status: 404, json: { message: "not found" } });
  });
  await page.route("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": incomingOrigin, "Access-Control-Allow-Methods": "PUT,OPTIONS" } });
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ status: 200, headers: { ETag: `"${"1".repeat(32)}"`, "Access-Control-Allow-Origin": incomingOrigin, "Access-Control-Expose-Headers": "ETag" } });
  });
  await page.goto(incomingUrl);
  await page.getByLabel("Your name").fill("Client Tester");
  await page.getByLabel("Email").fill("client@example.test");
  await page.getByRole("button", { name: "Continue securely" }).click();
  await page.locator("#files").setInputFiles({ name: "large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(64, 7) });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  expect(cancelCalls).toBe(1);
});

test("incoming page reuses its saved client upload ID after reopening and reselecting a failed file", async ({ page }) => {
  const source = Buffer.from("resume-after-reopen");
  const initBodies: Array<{ clientUploadId: string }> = [];
  await page.route(incomingUrl, route => route.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com" }, body: incomingRequestPage({ publicId: "request-a", title: "Upload files", requiresAccessCode: false }) }));
  await page.route("**/api/public/requests/request-a/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/authorize")) return route.fulfill({ json: { ok: true } });
    if (path.endsWith("/files/init")) {
      initBodies.push(JSON.parse(request.postData() ?? "{}"));
      return route.fulfill({ json: { fileId: "file-1", partSize: source.length, status: "uploading", completedParts: [] } });
    }
    if (path.endsWith("/part-ticket")) return route.fulfill({ json: { url: r2Url, expiresIn: 300, partNumber: 1, contentLength: source.length, contentType: "application/pdf" } });
    return route.fulfill({ status: 404, json: { message: "not found" } });
  });
  await page.route("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/**", route => route.fulfill({ status: 500, headers: { "Access-Control-Allow-Origin": incomingOrigin } }));

  const selectSameFile = async () => {
    await page.getByLabel("Your name").fill("Client Tester");
    await page.getByLabel("Email").fill("client@example.test");
    await page.getByRole("button", { name: "Continue securely" }).click();
    await page.locator("#files").evaluate((input, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType, lastModified: file.lastModified }));
      (input as HTMLInputElement).files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, { bytes: [...source], name: "reopen.pdf", mimeType: "application/pdf", lastModified: 1_700_000_000_000 });
  };

  await page.goto(incomingUrl);
  await selectSameFile();
  await expect(page.getByText(/You can select the file again to retry/)).toBeVisible();
  await page.reload();
  await selectSameFile();
  await expect.poll(() => initBodies.length).toBe(2);
  const [firstInit, secondInit] = initBodies;
  expect(firstInit).toBeDefined();
  expect(secondInit).toBeDefined();
  expect(secondInit!.clientUploadId).toBe(firstInit!.clientUploadId);
});
