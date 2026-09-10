import { expect, test } from "@playwright/test";

for (const scenario of ["legacy", "verifying", "verified", "basic_ready", "removed", "changed"] as const) {
test(`incoming upload download gating: ${scenario}`, async ({ page }) => {
  const verificationState = scenario === "legacy" ? undefined : scenario === "verifying" ? "scanning" : "verified";
  let downloadAvailable = scenario === "verified" || scenario === "basic_ready";
  const promotion = scenario === "basic_ready" ? { state: "ready", objectAvailability: "present" } : undefined;
  let downloadRequests = 0;
  let holdNext = false;
  let releaseNext: (() => void) | undefined;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/download")) { downloadRequests++; return route.fulfill({ body: "fixture only" }); }
    if (path.endsWith("/archive-inventory")) {
      const params = new URL(route.request().url()).searchParams;
      if (!downloadAvailable) return route.fulfill({ json: { status: "unavailable", items: [], nextCursor: null } });
      const folder = params.get("path"), query = params.get("q"), cursor = params.get("cursor");
      if (cursor && holdNext) await new Promise<void>(resolve => { releaseNext = resolve; });
      const items = folder === "photos"
        ? [{ path: "photos/front.jpg", name: "front.jpg", kind: "file", size: 100 }]
        : cursor ? [{ path: "notes.txt", name: "notes.txt", kind: "file", size: 0 }]
        : [{ path: "photos", name: "photos", kind: "folder" }, { path: "readme.txt", name: "readme.txt", kind: "file", size: 20 }];
      return route.fulfill({ json: { status: "ready", items: query ? items.filter(item => item.name.includes(query)) : items,
        nextCursor: !folder && !query && !cursor ? "fixture-next" : null } }).catch(() => {});
    }
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-incoming", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "file_requests.view"], divisions: [] },
      csrfToken: "csrf-incoming", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { incomingUploads: { enabled: true, reason: "available" } },
    } });
    if (path === "/api/delivery/incoming-link/uploads") {
      const params = new URL(route.request().url()).searchParams;
      const q = params.get("q"), next = params.get("cursor");
      const uploads = q === "missing" ? [] : next
        ? [{ id: "older-two", originalName: "Older second.jpg", contributorName: "Example contributor", status: "accepted" }]
        : [{ id: "upload-one", originalName: "iCloud Photos.zip", contributorName: "Example contributor", status: "quarantined", verificationState: "verified" }];
      return route.fulfill({ json: { uploads, nextCursor: !q && !next ? "older-page" : null } });
    }
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
      verificationState: scenario === "basic_ready" ? "awaiting_verification" : verificationState, promotion, downloadAvailable,
      pickupLastAttemptAt: "2026-09-05T13:00:00.000Z", pickupNextAttemptAt: "2026-09-05T14:00:00.000Z",
      createdAt: "2026-09-05T12:10:00.000Z", bucketObject: { state: scenario === "removed" ? "removed" : "present", size: 893_398_388, contentType: "application/zip" },
    } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery/incoming");
  const uploads = page.getByRole("heading", { name: "Recent uploads" }).locator("..").locator("..");
  await expect(uploads).toContainText("iCloud Photos.zip");
  await expect(uploads).toContainText("Server pickup will retry");
  await expect(uploads).toContainText("Next retry");
  await expect(uploads).toContainText("does not mean malware was detected");
  if (scenario === "legacy") {
    await uploads.getByRole("button", { name: "Browse all uploads" }).click();
    const browser = page.getByRole("region", { name: "Browse incoming uploads" });
    await expect(browser.getByText("1 uploads shown · more available", { exact: true })).toBeVisible();
    await browser.getByRole("button", { name: "Load more uploads" }).click();
    await expect(browser.getByText("Older second.jpg", { exact: true })).toBeVisible();
    await browser.getByLabel("Search files or contributors").fill("missing");
    await expect(browser.getByText("No matching uploads.", { exact: true })).toBeVisible();
    await expect(browser.getByText("Older second.jpg", { exact: true })).toHaveCount(0);
    await browser.getByLabel("Search files or contributors").fill("");
    await expect(browser.getByRole("button", { name: "Inspect upload" })).toHaveCount(1);
    await browser.getByRole("button", { name: "Inspect upload" }).click();
    await expect(page.getByRole("heading", { name: "Incoming upload record" })).toBeVisible();
    expect(downloadRequests).toBe(0);
    await uploads.getByRole("button", { name: "Close upload browser" }).click();
    await expect(browser).toHaveCount(0);
  }
  await uploads.getByRole("button", { name: "Inspect upload" }).click();
  if (scenario !== "removed") await expect(page.getByText("Private incoming object present", { exact: false })).toBeVisible();
  await expect(page.getByText("Archive listings contain metadata only", { exact: false })).toBeVisible();
  const download = page.getByRole("link", { name: scenario === "basic_ready" ? "Download file" : "Download verified file" });
  if (downloadAvailable) {
    await expect(download).toHaveAttribute("href", "/api/delivery/incoming-link/uploads/upload-one/download");
    await expect(download).toHaveAttribute("download", "");
    const archive = page.getByRole("region", { name: "Incoming archive", exact: true });
    await expect(archive.getByRole("button", { name: "photos/", exact: true })).toBeVisible();
    await archive.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(archive.getByText("notes.txt (0 bytes)", { exact: true })).toBeVisible();
    await archive.getByRole("button", { name: "photos/", exact: true }).click();
    await expect(archive.getByText("front.jpg (100 bytes)", { exact: true })).toBeVisible();
    await expect(archive.getByText("readme.txt (20 bytes)", { exact: true })).toHaveCount(0);
    await archive.getByLabel("Search archive names").fill("missing");
    await expect(archive.getByText("0 items shown in this folder", { exact: true })).toBeVisible();
    await archive.getByLabel("Search archive names").fill("");
    await archive.getByRole("button", { name: "Root", exact: true }).click();
    await expect(archive.getByRole("button", { name: "photos/", exact: true })).toBeVisible();
    await expect(archive.getByRole("link")).toHaveCount(0);
    holdNext = true;
    await archive.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(archive.getByRole("button", { name: "Loading…", exact: true })).toBeVisible();
    await archive.getByRole("button", { name: "photos/", exact: true }).click();
    await expect(archive.getByText("front.jpg (100 bytes)", { exact: true })).toBeVisible();
    releaseNext?.();
    await expect(archive.getByText("notes.txt (0 bytes)", { exact: true })).toHaveCount(0);
    downloadAvailable = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(download).toHaveCount(0);
  } else {
    await expect(download).toHaveCount(0);
    await expect(page.getByText(scenario === "removed" ? "This file is no longer in the incoming bucket." : "Download becomes available after verification passes", { exact: false })).toBeVisible();
  }
  expect(downloadRequests).toBe(0);
});
}
