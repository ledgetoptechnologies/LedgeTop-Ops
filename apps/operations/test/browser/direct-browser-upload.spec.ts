import { expect, test, type Page, type Route } from "@playwright/test";

type RequestRecord = {
  method: string;
  path: string;
  origin: string;
  headers: Record<string, string>;
  json?: unknown;
  body?: Buffer;
};

type UploadApiOptions = {
  administrator?: boolean;
  uploadPermission?: boolean;
  uploadCapability?: boolean;
  rejectPartWith?: 401 | 403;
};

function session(options: UploadApiOptions) {
  const administrator = options.administrator ?? true;
  const uploadPermission = options.uploadPermission ?? true;
  return {
    user: {
      id: "staff-upload-test",
      email: "staff-upload-test@example.test",
      displayName: "Upload Test Staff",
      status: "Active",
      profileType: administrator ? "Administrator" : "Employee",
      isAdministrator: administrator,
      permissions: [
        "delivery.browse",
        "delivery.files.create",
        ...(uploadPermission ? ["delivery.files.upload"] : []),
      ],
      divisions: [],
    },
    csrfToken: "csrf-browser-upload-test",
    timezone: "America/Chicago",
    mapStyleUrl: null,
    mapboxPublicToken: null,
    capabilities: {
      directDeliveryUploads: {
        enabled: options.uploadCapability ?? true,
        reason: options.uploadCapability === false ? "disabled" : "available",
      },
      incomingUploads: { enabled: false, reason: "disabled" },
      dropboxImport: { enabled: false, reason: "disabled" },
    },
  };
}

async function installUploadApi(page: Page, options: UploadApiOptions = {}) {
  const requests: RequestRecord[] = [];
  let intentSequence = 0;

  await page.route("**/api/**", async (route: Route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const path = url.pathname;
    const record: RequestRecord = {
      method: incoming.method(),
      path,
      origin: url.origin,
      headers: incoming.headers(),
    };
    if (incoming.postData()) {
      const contentType = incoming.headers()["content-type"] || "";
      if (contentType.includes("application/json")) record.json = incoming.postDataJSON();
      else record.body = incoming.postDataBuffer() || undefined;
    }
    requests.push(record);

    if (path === "/api/session") {
      await route.fulfill({ json: session(options) });
      return;
    }
    if (incoming.method() === "GET" && path === "/api/delivery/folders") {
      await route.fulfill({ json: { folders: [], files: [] } });
      return;
    }
    if (incoming.method() === "GET" && path === "/api/delivery/trash") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (incoming.method() === "POST" && path === "/api/delivery/uploads/intents") {
      intentSequence += 1;
      await route.fulfill({ status: 201, json: { intentId: `intent-${intentSequence}` } });
      return;
    }
    if (incoming.method() === "POST" && path === "/api/delivery/uploads") {
      const ordinal = Number((record.json as { ordinal: number }).ordinal);
      await route.fulfill({
        status: 201,
        json: { sessionId: `session-${ordinal}`, partSize: 3, status: "active" },
      });
      return;
    }
    const checkpoint = path.match(/^\/api\/delivery\/uploads\/(session-\d+)$/);
    if (incoming.method() === "GET" && checkpoint) {
      await route.fulfill({
        json: { sessionId: checkpoint[1], partSize: 3, status: "active", parts: [] },
      });
      return;
    }
    const part = path.match(/^\/api\/delivery\/uploads\/(session-\d+)\/parts\/(\d+)$/);
    if (incoming.method() === "PUT" && part) {
      if (options.rejectPartWith) {
        await route.fulfill({
          status: options.rejectPartWith,
          json: { error: options.rejectPartWith === 401 ? "Session expired" : "Upload grant revoked" },
        });
      } else {
        await route.fulfill({ json: { etag: `etag-${part[1]}-${part[2]}` } });
      }
      return;
    }
    if (
      incoming.method() === "POST" &&
      /^\/api\/delivery\/uploads\/session-\d+\/complete$/.test(path)
    ) {
      await route.fulfill({ json: { status: "completed" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unhandled test route: ${path}` } });
  });

  return requests;
}

function apiMutations(requests: RequestRecord[]) {
  return requests.filter(
    (request) => request.path.startsWith("/api/delivery/uploads") && request.method !== "GET",
  );
}

async function setFolderFiles(
  page: Page,
  files: Array<{ name: string; relativePath: string; mimeType: string; bytes: number[] }>,
) {
  await page.locator('input[type="file"][webkitdirectory]').evaluate(
    (input, entries) => {
      const transfer = new DataTransfer();
      for (const entry of entries) {
        const file = new File([new Uint8Array(entry.bytes)], entry.name, { type: entry.mimeType });
        Object.defineProperty(file, "webkitRelativePath", {
          configurable: false,
          enumerable: true,
          value: entry.relativePath,
        });
        transfer.items.add(file);
      }
      (input as HTMLInputElement).files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    files,
  );
}

test("direct upload controls require the runtime capability, administrator role, and upload grant", async ({
  page,
}) => {
  await installUploadApi(page, { uploadCapability: false });
  await page.goto("/delivery");

  await expect(page.getByText("Direct browser uploads are disabled. Use an Incoming request link.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Upload folder" })).toBeDisabled();
  await expect(page.getByLabel("Upload collision policy")).toBeDisabled();

  await page.unrouteAll({ behavior: "wait" });
  await installUploadApi(page, { administrator: false });
  await page.reload();

  await expect(page.getByText("Direct browser uploads require administrator access.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Upload folder" })).toBeDisabled();

  await page.unrouteAll({ behavior: "wait" });
  const deniedRequests = await installUploadApi(page, { uploadPermission: false });
  await page.reload();
  await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Upload folder" })).toBeDisabled();
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: "denied.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([1]),
  });
  await expect.poll(() => apiMutations(deniedRequests).length).toBe(0);
});

test("single-file upload uses a same-origin resumable sequence and exposes byte progress", async ({ page }) => {
  const requests = await installUploadApi(page);
  await page.goto("/delivery");
  await page.getByLabel("Upload collision policy").selectOption("rename");

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: "site-photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([1, 2, 3, 4, 5, 6]),
  });

  await expect(page.getByText("1/1 files complete", { exact: true })).toBeVisible();
  await expect(page.getByLabel("site-photo.jpg upload progress")).toHaveAttribute("value", "6");
  await expect(page.getByText("6 B of 6 B")).toBeVisible();
  await expect(page.getByText("Uploaded 1 of 1 item")).toBeVisible();

  const mutations = apiMutations(requests);
  expect(mutations.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/delivery/uploads/intents",
    "POST /api/delivery/uploads",
    "PUT /api/delivery/uploads/session-0/parts/1",
    "PUT /api/delivery/uploads/session-0/parts/2",
    "POST /api/delivery/uploads/session-0/complete",
  ]);
  const intent = mutations[0]!;
  expect(intent.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(intent.json).toEqual({
    rootPrefix: "Jobs/Clients/",
    collisionPolicy: "rename",
    files: [{ relativePath: "site-photo.jpg", size: 6, contentType: "image/jpeg" }],
  });
  expect(mutations.every((request) => request.headers["x-csrf-token"] === "csrf-browser-upload-test")).toBe(true);
  expect(mutations.every((request) => request.origin === "http://127.0.0.1:4174")).toBe(true);
  expect(
    requests
      .filter((request) => request.path.startsWith("/api/delivery/uploads"))
      .map(({ method, path }) => `${method} ${path}`),
  ).toEqual([
    "POST /api/delivery/uploads/intents",
    "POST /api/delivery/uploads",
    "GET /api/delivery/uploads/session-0",
    "PUT /api/delivery/uploads/session-0/parts/1",
    "PUT /api/delivery/uploads/session-0/parts/2",
    "POST /api/delivery/uploads/session-0/complete",
  ]);
  expect(mutations.filter((request) => request.method === "PUT").map((request) => request.body)).toEqual([
    Buffer.from([1, 2, 3]),
    Buffer.from([4, 5, 6]),
  ]);
});

test("folder upload preserves webkit relative paths and the selected replacement policy", async ({ page }) => {
  const requests = await installUploadApi(page);
  await page.goto("/delivery/Acme/Project-7");
  await page.getByLabel("Upload collision policy").selectOption("replace");

  await setFolderFiles(page, [
    { name: "front.jpg", relativePath: "Album/front.jpg", mimeType: "image/jpeg", bytes: [1, 2] },
    { name: "map.png", relativePath: "Album/Maps/map.png", mimeType: "image/png", bytes: [3, 4, 5] },
  ]);

  await expect(page.getByText("2/2 files complete", { exact: true })).toBeVisible();
  await expect(page.getByText("Album/front.jpg", { exact: true })).toBeVisible();
  await expect(page.getByText("Album/Maps/map.png", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Album/front.jpg upload progress")).toHaveAttribute("value", "2");
  await expect(page.getByLabel("Album/Maps/map.png upload progress")).toHaveAttribute("value", "3");

  const intent = requests.find(
    (request) => request.method === "POST" && request.path === "/api/delivery/uploads/intents",
  )!;
  expect(intent.json).toEqual({
    rootPrefix: "Jobs/Clients/Acme/Project-7/",
    collisionPolicy: "replace",
    files: [
      { relativePath: "Album/front.jpg", size: 2, contentType: "image/jpeg" },
      { relativePath: "Album/Maps/map.png", size: 3, contentType: "image/png" },
    ],
  });
  expect(
    apiMutations(requests).map(({ method, path }) => `${method} ${path}`),
  ).toEqual([
    "POST /api/delivery/uploads/intents",
    "POST /api/delivery/uploads",
    "PUT /api/delivery/uploads/session-0/parts/1",
    "POST /api/delivery/uploads/session-0/complete",
    "POST /api/delivery/uploads",
    "PUT /api/delivery/uploads/session-1/parts/1",
    "POST /api/delivery/uploads/session-1/complete",
  ]);
});

for (const status of [401, 403] as const) {
  test(`${status} during a part halts the batch and shows the reauthorization recovery`, async ({ page }) => {
    const requests = await installUploadApi(page, { rejectPartWith: status });
    await page.goto("/delivery");

    await setFolderFiles(page, [
      { name: "first.jpg", relativePath: "Batch/first.jpg", mimeType: "image/jpeg", bytes: [1, 2, 3] },
      { name: "second.jpg", relativePath: "Batch/second.jpg", mimeType: "image/jpeg", bytes: [4, 5, 6] },
    ]);

    const recovery = "Upload stopped because your Operations authorization expired or changed. Reauthenticate and verify access before retrying.";
    await expect(page.locator(".operation-status.error")).toContainText(recovery);
    await expect(page.getByText("stopped", { exact: true })).toHaveCount(2);
    await expect(page.getByText(recovery, { exact: false })).toHaveCount(3);

    expect(
      apiMutations(requests).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /api/delivery/uploads/intents",
      "POST /api/delivery/uploads",
      "PUT /api/delivery/uploads/session-0/parts/1",
    ]);
  });
}
