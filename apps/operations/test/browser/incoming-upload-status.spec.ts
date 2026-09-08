import { expect, test } from "@playwright/test";

test("incoming uploads describe quarantine as pending verification rather than a malware verdict", async ({ page }) => {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-incoming", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "file_requests.view"], divisions: [] },
      csrfToken: "csrf-incoming", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { incomingUploads: { enabled: true, reason: "available" } },
    } });
    if (path === "/api/delivery/incoming-link") return route.fulfill({ json: { link: {
      id: "incoming-one", url: "https://incoming.example.test/request", title: "Send project files", maxFiles: 10,
      maxBytes: 2_000_000_000, accessCodeProtected: false, createdAt: "2026-09-05T12:00:00.000Z",
      outstandingFiles: 1, outstandingBytes: 893_398_388,
      recentUploads: [{ id: "upload-one", fileName: "iCloud Photos.zip", contributorName: "Joe Gaworecki",
        size: 893_398_388, status: "quarantined", pickupState: "retry", pickupAttemptCount: 1,
        pickupLastAttemptAt: "2026-09-05T13:00:00.000Z", pickupNextAttemptAt: "2026-09-05T14:00:00.000Z",
        uploadedAt: "2026-09-05T12:10:00.000Z" }],
    } } });
    if (path === "/api/delivery/incoming-link/uploads/upload-one") return route.fulfill({ json: { upload: {
      id: "upload-one", fileName: "iCloud Photos.zip", contributorName: "Joe Gaworecki", declaredSize: 893_398_388,
      contentType: "application/zip", status: "quarantined", pickupState: "retry", pickupAttemptCount: 1,
      pickupLastAttemptAt: "2026-09-05T13:00:00.000Z", pickupNextAttemptAt: "2026-09-05T14:00:00.000Z",
      createdAt: "2026-09-05T12:10:00.000Z", bucketObject: { state: "present", size: 893_398_388, contentType: "application/zip" },
    } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery/incoming");
  const uploads = page.getByRole("heading", { name: "Recent uploads" }).locator("..").locator("..");
  await expect(uploads).toContainText("iCloud Photos.zip");
  await expect(uploads).toContainText("Server pickup will retry");
  await expect(uploads).toContainText("Next retry");
  await expect(uploads).toContainText("does not mean malware was detected");
  await uploads.getByRole("button", { name: "Inspect upload" }).click();
  await expect(page.getByText("Private incoming object present", { exact: false })).toBeVisible();
  await expect(page.getByText("safe, per-file browse view", { exact: false })).toBeVisible();
});
