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
        size: 893_398_388, status: "quarantined", uploadedAt: "2026-09-05T12:10:00.000Z" }],
    } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery/incoming");
  const uploads = page.getByRole("heading", { name: "Recent uploads" }).locator("..").locator("..");
  await expect(uploads).toContainText("iCloud Photos.zip");
  await expect(uploads).toContainText("Pending verification");
  await expect(uploads).toContainText("does not mean malware was detected");
  await expect(uploads).not.toContainText("Awaiting server scan");
});
