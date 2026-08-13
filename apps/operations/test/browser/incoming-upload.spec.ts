import { expect, test } from "@playwright/test";
import { incomingRequestPage } from "../../src/worker/incoming-page";

const incomingUrl = "http://127.0.0.1:4174/incoming-test";
const incomingOrigin = "http://127.0.0.1:4174";
const r2Url = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/incoming/object?uploadId=upload-1&partNumber=1";

test("incoming page sends file bytes only to R2 and completes through checkpoints", async ({ page }) => {
  const source = Buffer.from("safe-photo-bytes");
  const workerBodies: Buffer[] = [];
  let r2Body: Buffer | null = null;

  await page.route(incomingUrl, route => route.fulfill({
    status: 200,
    contentType: "text/html",
    headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com" },
    body: incomingRequestPage({ publicId: "request-a", title: "Upload files" }),
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
  await page.getByLabel("Your name").fill("Client Tester");
  await page.getByLabel("Email").fill("client@example.test");
  await page.getByRole("button", { name: "Continue securely" }).click();
  await page.locator("#files").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: source });
  await expect(page.getByText("Uploaded successfully", { exact: true })).toBeVisible();
  expect(r2Body).toEqual(source);
  expect(workerBodies.some(body => body.equals(source))).toBe(false);
  expect(JSON.parse(workerBodies.find(body => body.toString().includes("resumeFingerprint"))!.toString()).resumeFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("incoming page cancels an in-flight direct upload and clears its saved resume", async ({ page }) => {
  let cancelCalls = 0;
  await page.route(incomingUrl, route => route.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com" }, body: incomingRequestPage({ publicId: "request-a", title: "Upload files" }) }));
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
