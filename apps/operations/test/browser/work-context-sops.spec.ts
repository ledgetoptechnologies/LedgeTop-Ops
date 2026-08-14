import { expect, test, type Page } from "@playwright/test";

const revisionOne = "11111111-1111-4111-8111-111111111111";
const revisionTwo = "22222222-2222-4222-8222-222222222222";

const firstLink = {
  sopId: "sop-lidar",
  revisionId: revisionOne,
  revisionNumber: 1,
  slug: "lidar-capture",
  title: "LiDAR capture",
  purpose: "Collect a LiDAR dataset safely.",
  publishedAt: "2026-08-10T12:00:00Z",
  linkedAt: "2026-08-11T12:00:00Z",
  archived: false,
  href: `/sops/lidar-capture/revisions/${revisionOne}?contextKind=project&contextId=project-1`,
};

async function mock(page: Page) {
  let projectLinks = [firstLink];
  let projectVersion = 1;
  await page.route("**/api/**", async route => {
    const incoming = route.request();
    const path = new URL(incoming.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-admin",
          email: "admin@example.test",
          displayName: "Operations Admin",
          status: "Active",
          profileType: "Administrator",
          isAdministrator: true,
          permissions: ["operations.view", "operations.manage", "projects.view", "tasks.view", "tasks.update", "sops.view"],
          divisions: [],
        },
        csrfToken: "csrf-context-sops",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: {},
      } });
    } else if (path === "/api/projects") {
      await route.fulfill({ json: { projects: [{
        id: "project-1",
        name: "North site",
        status: "active",
        customer_name: "Delsman Construction",
        manager_name: "Project Manager",
        start_date: "2026-08-01",
        sopLinks: projectLinks,
        sopLinkVersion: projectVersion,
        canManageSops: true,
      }] } });
    } else if (path === "/api/tasks") {
      await route.fulfill({ json: { tasks: [{
        id: "task-1",
        title: "Capture LiDAR",
        status: "todo",
        description: "Capture the north parcel.",
        assigned_name: "Colin Pilot",
        due_at: "2026-08-15T12:00:00Z",
        sopLinks: [],
        sopLinkVersion: 0,
        canManageSops: true,
      }] } });
    } else if (incoming.method() === "GET" && path === "/api/work-contexts/project/project-1/sops") {
      await route.fulfill({ json: { version: projectVersion, sops: projectLinks, canEdit: true } });
    } else if (incoming.method() === "PUT" && path === "/api/work-contexts/project/project-1/sops") {
      const payload = incoming.postDataJSON() as { expectedVersion: number; revisionIds: string[] };
      expect(payload).toEqual({ expectedVersion: 1, revisionIds: [revisionOne, revisionTwo] });
      expect(incoming.headers()["x-csrf-token"]).toBe("csrf-context-sops");
      projectVersion = 2;
      projectLinks = [firstLink, {
        ...firstLink,
        sopId: "sop-site-safety",
        revisionId: revisionTwo,
        revisionNumber: 4,
        slug: "site-safety",
        title: "Site safety",
        purpose: "Review site hazards before capture.",
        href: `/sops/site-safety/revisions/${revisionTwo}?contextKind=project&contextId=project-1`,
      }];
      await route.fulfill({ json: { version: projectVersion, sops: projectLinks, canEdit: true } });
    } else if (path === "/api/sops") {
      await route.fulfill({ json: { sops: [{
        id: "sop-lidar",
        slug: "lidar-capture",
        title: "LiDAR capture",
        purpose: "Collect a LiDAR dataset safely.",
        publishedRevisionId: revisionOne,
        publishedRevisionNumber: 1,
      }, {
        id: "sop-site-safety",
        slug: "site-safety",
        title: "Site safety",
        purpose: "Review site hazards before capture.",
        publishedRevisionId: revisionTwo,
        publishedRevisionNumber: 4,
      }] } });
    } else if (path === `/api/sops/lidar-capture/revisions/${revisionOne}`) {
      await route.fulfill({ json: { sop: {
        id: "sop-lidar",
        slug: "lidar-capture",
        status: "published",
        version: 3,
        title: "LiDAR capture",
        purpose: "Collect a LiDAR dataset safely.",
        createdAt: "2026-08-01T12:00:00Z",
        updatedAt: "2026-08-10T12:00:00Z",
        publishedAt: "2026-08-10T12:00:00Z",
        revision: {
          id: revisionOne,
          revisionNumber: 1,
          title: "LiDAR capture",
          purpose: "Collect a LiDAR dataset safely.",
          html: "<h2>Before capture</h2><p>Confirm the approved scan pattern.</p>",
          toc: [],
          author: { id: "staff-admin", displayName: "Operations Admin" },
          createdAt: "2026-08-10T12:00:00Z",
          publishedAt: "2026-08-10T12:00:00Z",
        },
      } } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

test("Project and Task cards expose direct keyboard-accessible pinned SOP revisions", async ({ page }) => {
  await mock(page);
  await page.goto("/operations/projects");

  const projectQuickSops = page.getByRole("region", { name: "Project quick SOPs" });
  const chip = projectQuickSops.getByRole("link", { name: /LiDAR capture Revision 1/ });
  await expect(chip).toHaveAttribute("href", `/sops/lidar-capture/revisions/${revisionOne}?contextKind=project&contextId=project-1`);
  await chip.focus();
  await expect(chip).toBeFocused();
  if ((page.viewportSize()?.width || 0) <= 640) {
    const box = await chip.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  const manager = projectQuickSops.getByText("Manage quick SOPs", { exact: true });
  await manager.focus();
  await manager.press("Enter");
  await expect(projectQuickSops.getByText(/do not inherit to related work/i)).toBeVisible();
  await projectQuickSops.getByRole("checkbox", { name: /Site safety/ }).check();
  await projectQuickSops.getByRole("button", { name: "Save SOP links" }).click();
  await expect(projectQuickSops.getByRole("link", { name: /Site safety Revision 4/ })).toBeVisible();
  await expect(projectQuickSops.getByRole("status")).toContainText("Quick SOP links saved");

  await chip.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/sops/lidar-capture/revisions/${revisionOne}\\?contextKind=project&contextId=project-1$`));
  await expect(page.getByRole("heading", { name: "LiDAR capture", level: 1 })).toBeVisible();
  await expect(page.getByText("Confirm the approved scan pattern.")).toBeVisible();
  await expect(page.getByText("Revision 1")).toBeVisible();

  await page.goto("/operations/tasks");
  const taskQuickSops = page.getByRole("region", { name: "Task quick SOPs" });
  await expect(taskQuickSops).toContainText("No SOP revisions are pinned directly to this task");
  await expect(taskQuickSops.getByRole("link", { name: /LiDAR capture/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
