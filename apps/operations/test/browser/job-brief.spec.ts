import { expect, test, type Page } from "@playwright/test";

const operation = {
  id: "operation-1",
  title: "North parcel mapping",
  project_name: "North Site",
  division_name: "Flight Operations",
  scheduled_start: "2026-08-10T15:00:00.000Z",
  status: "scheduled",
};

function brief(canEdit: boolean, version = 1, items = [
  { id: "scope-map", category: "Mapping mission", title: "Orthomosaic", instructions: "Fly 300 ft AGL with 80/75 overlap.", sortOrder: 0, presetRef: null },
  { id: "scope-photo", category: "Marketing photos", title: "Exterior set", instructions: "Capture front, side, and context views.", sortOrder: 1, presetRef: null },
], canAssignSops = canEdit) {
  return {
    operation: {
      id: operation.id,
      title: operation.title,
      status: operation.status,
      scheduledStart: operation.scheduled_start,
      scheduledEnd: null,
      location: "North parcel",
      navigation: {
        latitude: 44.765432,
        longitude: -88.123456,
        label: "North field",
        coordinateSource: "fallback_point",
        googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=44.765432%2C-88.123456",
        appleMapsUrl: "https://maps.apple.com/?ll=44.765432%2C-88.123456&q=North%20field",
      },
    },
    brief: {
      version,
      items,
      attachments: [{
        id: "attachment-kml",
        versionAdded: 1,
        sourceKind: "project_file",
        displayName: "north-boundary.kml",
        contentType: "application/vnd.google-earth.kml+xml",
        size: 2048,
        createdBy: { id: "staff-a", displayName: "Staff Planner" },
        createdAt: "2026-08-02T12:00:00.000Z",
        contentUrl: "/api/operations/operation-1/job-brief/attachments/attachment-kml/content",
      }],
      sops: [{
        sopId: "sop-mapping",
        revisionId: "revision-mapping-3",
        revisionNumber: 3,
        slug: "mapping-flight",
        title: "Mapping Flight SOP",
        purpose: "Standard capture checks for mapping flights.",
        html: '<h2 id="sop-heading-capture">Capture checks</h2><p>Confirm exact overlap from this job brief.</p>',
        toc: [{ id: "sop-heading-capture", level: 2, text: "Capture checks" }],
        author: { id: "staff-a", displayName: "Staff Planner" },
        publishedAt: "2026-08-01T12:00:00.000Z",
        linkedAt: "2026-08-02T12:00:00.000Z",
        publicationState: "current" as const,
      }],
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      updatedBy: { id: "staff-a", displayName: "Staff Planner", email: "staff@example.com" },
    },
    history: [{ version, changeKind: "scope_saved", author: { id: "staff-a", displayName: "Staff Planner", email: "staff@example.com" }, createdAt: "2026-08-02T12:00:00.000Z" }],
    canEdit,
    canViewSops: true,
    canAssignSops,
  };
}

async function mock(page: Page, canEdit: boolean, canAssignSops = canEdit,
  navigation?: ReturnType<typeof brief>["operation"]["navigation"] | null) {
  let current = brief(canEdit, 1, undefined, canAssignSops);
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const path = new URL(incoming.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: canEdit ? "staff-a" : "pilot-a",
          email: canEdit ? "staff@example.com" : "pilot@example.com",
          displayName: canEdit ? "Staff Planner" : "Colin Pilot",
          status: "Active",
          profileType: canEdit ? "Administrator" : "Employee",
          isAdministrator: canEdit,
          permissions: ["operations.view", "sops.view", ...(canEdit ? ["operations.manage", "delivery.browse"] : []), ...(canAssignSops ? ["sops.assign"] : [])],
          divisions: [],
        },
        csrfToken: "csrf-test",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: {},
      } });
    } else if (incoming.method() === "GET" && path === "/api/operations") {
      await route.fulfill({ json: { operations: [operation] } });
    } else if (incoming.method() === "GET" && path === "/api/operations/operation-1/job-brief") {
      await route.fulfill({ json: {
        ...current,
        operation: { ...current.operation, navigation: navigation === undefined ? current.operation.navigation : navigation },
      } });
    } else if (incoming.method() === "GET" && path === "/api/sops") {
      await route.fulfill({ json: { sops: [{
        id: "sop-mapping",
        title: "Mapping Flight SOP",
        purpose: "Standard capture checks for mapping flights.",
        publishedRevisionId: "revision-mapping-3",
        publishedRevisionNumber: 3,
      }] } });
    } else if (incoming.method() === "PUT" && path === "/api/operations/operation-1/job-brief") {
      const payload = incoming.postDataJSON() as { expectedVersion: number; items: any[] };
      expect(payload.expectedVersion).toBe(1);
      expect(payload.items).toHaveLength(3);
      expect(incoming.headers()["x-csrf-token"]).toBe("csrf-test");
      current = brief(true, 2, payload.items.map((item, sortOrder) => ({ ...item, sortOrder })), canAssignSops);
      await route.fulfill({ json: current });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
  return {
    advance(version: number, instructions: string) {
      current = brief(canEdit, version, current.brief.items.map((item, index) =>
        index === 0 ? { ...item, instructions } : item,
      ), canAssignSops);
    },
  };
}

test("staff edits a multi-item brief and gets mobile-friendly private KML and map actions", async ({ page }) => {
  await mock(page, true);
  await page.goto("/operations");
  await page.getByRole("button", { name: "View brief" }).click();

  await expect(page.locator('input[value="Mapping mission"]')).toBeVisible();
  await expect(page.locator('input[value="Marketing photos"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Download KML for flight planning" })).toHaveAttribute(
    "href",
    "/api/operations/operation-1/job-brief/attachments/attachment-kml/content",
  );
  await expect(page.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/search/);
  await expect(page.getByRole("link", { name: "Apple Maps" })).toHaveAttribute("href", /^https:\/\/maps\.apple\.com\//);
  await expect(page.getByText(/not a guaranteed road or safe launch location/i)).toBeVisible();

  await page.getByRole("button", { name: "Add scope item" }).click();
  const last = page.locator(".job-brief-item-editor").last();
  await last.getByLabel("Category").fill("Special notes");
  await last.getByLabel("Title").fill("Launch access");
  await last.getByLabel("Operational instructions").fill("Use the west gate and keep it closed.");
  await page.getByRole("button", { name: "Save brief" }).click();
  await expect(page.getByText("Saved version 2")).toBeVisible();
  await expect(page.getByText("LTDS brief v2")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("assigned pilot sees the current brief without edit or delivery-browse controls", async ({ page }) => {
  await mock(page, false);
  await page.goto("/operations");
  await expect(page.getByRole("tab", { name: "SOP Library" })).toBeVisible();
  await expect(page.getByRole("link", { name: "SOP Library" })).toHaveCount(0);
  await page.getByRole("button", { name: "View brief" }).click();

  await expect(page.getByText("Fly 300 ft AGL with 80/75 overlap.")).toBeVisible();
  await expect(page.getByText("Capture front, side, and context views.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save brief" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add scope item" })).toHaveCount(0);
  await expect(page.getByText("Authorized client project file")).toBeVisible();
  await expect(page.getByLabel("Authorized client project file path")).toHaveCount(0);
  const quickSops = page.getByRole("navigation", { name: "Quick SOPs" });
  await expect(quickSops).toContainText("1");
  const quickLink = quickSops.getByRole("link", { name: /Mapping Flight SOP Revision 3/ });
  await quickLink.focus();
  await expect(quickLink).toBeFocused();
  await quickLink.press("Enter");
  await expect(page).toHaveURL(/#job-brief-sop-revision-mapping-3$/);
  await expect(page.locator("#job-brief-sop-revision-mapping-3")).toHaveAttribute("open", "");
  await expect(page.getByText("Confirm exact overlap from this job brief.")).toBeVisible();
  if ((page.viewportSize()?.width || 0) <= 640) {
    const box = await quickLink.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test("sops.assign exposes only the SOP pin editor, not the broader job-brief editor", async ({ page }) => {
  await mock(page, false, true);
  await page.goto("/operations?brief=operation-1");

  await expect(page.getByRole("group", { name: "Published SOP revisions available to this job" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Mapping Flight SOP.*Revision 3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save SOP links" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add scope item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save brief" })).toHaveCount(0);
});

test("background refresh preserves a dirty draft and explicit refresh adopts the newer version", async ({ page }) => {
  const server = await mock(page, true);
  await page.goto("/operations");
  await page.getByRole("button", { name: "View brief" }).click();

  const instructions = page.getByLabel("Operational instructions").first();
  await instructions.fill("Local unsaved altitude change");
  server.advance(2, "Server altitude change");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page.getByText("A newer brief is available. Refresh before saving your draft.")).toBeVisible();
  await expect(instructions).toHaveValue("Local unsaved altitude change");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(instructions).toHaveValue("Server altitude change");
  await expect(page.getByText("LTDS brief v2")).toBeVisible();
});

test("a job brief without an authorized destination has no external navigation", async ({ page }) => {
  await mock(page, false, false, null);
  await page.goto("/operations?brief=operation-1");
  await expect(page.getByRole("heading", { name: `Job brief · ${operation.title}` })).toBeVisible();
  await expect(page.getByText("Fly 300 ft AGL with 80/75 overlap.")).toBeVisible();
  await expect(page.getByRole("region", { name: "External navigation" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Google Maps" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Apple Maps" })).toHaveCount(0);
});

test("zero-coordinate job navigation wraps long labels without overflowing or losing keyboard actions", async ({ page }, testInfo) => {
  const label = `Survey site ${"FieldReference".repeat(12)}`;
  await mock(page, false, false, {
    latitude: 0, longitude: 0, label, coordinateSource: "fallback_point",
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=0.000000%2C0.000000",
    appleMapsUrl: `https://maps.apple.com/?ll=0.000000%2C0.000000&q=${encodeURIComponent(label)}`,
  });
  await page.goto("/operations?brief=operation-1");
  const navigation = page.getByRole("region", { name: "External navigation" });
  await expect(navigation).toContainText(`${label} · 0.000000, 0.000000`);
  for (const width of [375, 640, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const google = navigation.getByRole("link", { name: "Google Maps" });
    const apple = navigation.getByRole("link", { name: "Apple Maps" });
    await expect(google).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=0.000000%2C0.000000");
    await expect(apple).toHaveAttribute("href", `https://maps.apple.com/?ll=0.000000%2C0.000000&q=${encodeURIComponent(label)}`);
    await google.focus();
    await expect(google).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(apple).toBeFocused();
    const boxes = await navigation.evaluate(element => {
      const panel = element.getBoundingClientRect();
      return { left: panel.left, right: panel.right, overflow: element.scrollWidth > element.clientWidth,
        children: [...element.querySelectorAll("strong, small, a")].map(child => {
          const box = child.getBoundingClientRect();
          return { left: box.left, right: box.right, height: box.height, link: child.tagName === "A" };
        }) };
    });
    expect(boxes.left).toBeGreaterThanOrEqual(0);
    expect(boxes.right).toBeLessThanOrEqual(width);
    expect(boxes.overflow).toBe(false);
    for (const box of boxes.children) {
      expect(box.left).toBeGreaterThanOrEqual(boxes.left);
      expect(box.right).toBeLessThanOrEqual(boxes.right);
      if (box.link && width <= 640) expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await navigation.screenshot({ path: testInfo.outputPath(`job-navigation-zero-${width}.png`) });
  }
});
