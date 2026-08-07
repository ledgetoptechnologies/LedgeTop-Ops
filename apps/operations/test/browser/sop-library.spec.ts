import { expect, test, type Page } from "@playwright/test";

type Revision = {
  id: string;
  revisionNumber: number;
  changeKind: string;
  title: string;
  purpose: string;
  markdownBody: string;
  html: string;
  toc: Array<{ id: string; level: number; text: string }>;
  author: { id: string; displayName: string; email: string };
  createdAt: string;
  publishedAt: string | null;
};

const author = { id: "staff-admin", displayName: "Ops Admin", email: "admin@example.com" };
const published: Revision = {
  id: "revision-published",
  revisionNumber: 4,
  changeKind: "published",
  title: "Mapping Flight",
  purpose: "Pinned field guidance for mapping capture.",
  markdownBody: "# Mapping Flight\n\n## Capture\n\nUse 80/75 overlap.",
  html: '<h1 id="sop-heading-mapping-flight">Mapping Flight</h1><h2 id="sop-heading-capture">Capture</h2><p>Use <strong>80/75 overlap</strong>.</p>',
  toc: [
    { id: "sop-heading-mapping-flight", level: 1, text: "Mapping Flight" },
    { id: "sop-heading-capture", level: 2, text: "Capture" },
  ],
  author,
  createdAt: "2026-08-04T15:00:00Z",
  publishedAt: "2026-08-04T15:00:00Z",
};

function publicSummary() {
  return {
    id: "sop-mapping",
    slug: "mapping-flight",
    title: published.title,
    purpose: published.purpose,
    status: "published",
    version: 4,
    updatedAt: published.createdAt,
    publishedAt: published.publishedAt,
    publishedRevisionId: published.id,
    publishedRevisionNumber: published.revisionNumber,
    draftRevisionNumber: null,
  };
}

async function session(page: Page, administrator: boolean) {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: administrator ? "staff-admin" : "staff-pilot",
          email: administrator ? "admin@example.com" : "pilot@example.com",
          displayName: administrator ? "Ops Admin" : "Assigned Pilot",
          status: "Active",
          profileType: administrator ? "Administrator" : "Employee",
          isAdministrator: administrator,
          permissions: administrator ? ["sops.view", "sops.manage"] : ["sops.view"],
          divisions: [],
        },
        csrfToken: "csrf-test",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: {},
      } });
      return;
    }
    if (!administrator && request.method() === "GET" && url.pathname === "/api/sops") {
      const matches = !url.searchParams.get("search") || /mapping/i.test(url.searchParams.get("search") || "");
      await route.fulfill({ json: { sops: matches ? [publicSummary()] : [] } });
      return;
    }
    if (!administrator && request.method() === "GET" && url.pathname === "/api/sops/mapping-flight") {
      await route.fulfill({ json: { sop: { ...publicSummary(), revision: published } } });
      return;
    }
    await route.fallback();
  });
}

test("pilot searches and reads only a published responsive, printable SOP with TOC", async ({ page }) => {
  await session(page, false);
  await page.goto("/sops");
  await expect(page.getByRole("heading", { name: "Internal SOP library" })).toBeVisible();
  await page.getByLabel("Search SOPs").fill("mapping");
  await expect(page.getByRole("heading", { name: "Mapping Flight" })).toBeVisible();
  await expect(page.getByText("Draft flight notes")).toHaveCount(0);
  await page.getByRole("button", { name: "Read SOP" }).click();
  await expect(page.getByRole("navigation", { name: "Table of contents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture" })).toHaveAttribute("href", "#sop-heading-capture");
  await expect(page.getByText("80/75 overlap")).toBeVisible();
  await expect(page.getByText("Revision 4")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".ops-header")).toHaveCSS("display", "none");
  await expect(page.locator(".sop-document-heading > h1")).toHaveText("Mapping Flight");
});

test("administrator authors, previews, publishes, inspects history, restores, and sees stale conflicts", async ({ page }) => {
  let document: any = null;
  let revisions: Revision[] = [];
  let rejectDraft = false;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: { id: author.id, email: author.email, displayName: author.displayName, status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["sops.view", "sops.manage"], divisions: [] },
        csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/sops") {
      await route.fulfill({ json: { sops: [] } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/admin/sops") {
      await route.fulfill({ json: { sops: document ? [{
        id: document.id, slug: document.slug, title: (document.draftRevision || document.publishedRevision).title,
        purpose: (document.draftRevision || document.publishedRevision).purpose, status: document.status,
        version: document.version, updatedAt: document.updatedAt, publishedAt: document.publishedAt,
        draftRevisionNumber: document.draftRevision?.revisionNumber || null,
        publishedRevisionNumber: document.publishedRevision?.revisionNumber || null,
      }] : [] } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/admin/sops/sop-created") {
      await route.fulfill({ json: { sop: document, revisions } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/admin/sops") {
      const body = request.postDataJSON() as { title: string; slug: string; purpose: string; markdownBody: string };
      expect(request.headers()["x-csrf-token"]).toBe("csrf-test");
      const first: Revision = {
        ...published,
        id: "revision-1",
        revisionNumber: 1,
        changeKind: "created",
        title: body.title,
        purpose: body.purpose,
        markdownBody: body.markdownBody,
        html: '<h1 id="sop-heading-mapping-mission">Mapping Mission</h1><p>Preview saved.</p>',
        createdAt: "2026-08-04T14:00:00Z",
        publishedAt: null,
      };
      revisions = [first];
      document = { id: "sop-created", slug: body.slug, status: "draft", version: 1, createdAt: first.createdAt, updatedAt: first.createdAt, publishedAt: null, archivedAt: null, draftRevision: first, publishedRevision: null };
      await route.fulfill({ status: 201, json: { sop: document, revisions } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/admin/sops/sop-created/publish") {
      expect(request.headers()["if-match"]).toBe('"sop-1"');
      const second: Revision = { ...revisions[0]!, id: "revision-2", revisionNumber: 2, changeKind: "published", publishedAt: "2026-08-04T15:00:00Z" };
      revisions = [second, ...revisions];
      document = { ...document, status: "published", version: 2, draftRevision: null, publishedRevision: second, publishedAt: second.publishedAt };
      await route.fulfill({ json: { sop: document, revisions } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/admin/sops/sop-created/restore") {
      expect(request.headers()["if-match"]).toBe('"sop-2"');
      const source = revisions.find(item => item.id === (request.postDataJSON() as any).revisionId)!;
      const third: Revision = { ...source, id: "revision-3", revisionNumber: 3, changeKind: "restored", createdAt: "2026-08-04T16:00:00Z", publishedAt: null };
      revisions = [third, ...revisions];
      document = { ...document, version: 3, draftRevision: third };
      rejectDraft = true;
      await route.fulfill({ json: { sop: document, revisions } });
      return;
    }
    if (request.method() === "PUT" && url.pathname === "/api/admin/sops/sop-created/draft" && rejectDraft) {
      expect(request.headers()["if-match"]).toBe('"sop-3"');
      await route.fulfill({ status: 409, json: { error: "stale", currentVersion: 4, currentEtag: '"sop-4"' } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  page.on("dialog", dialog => void dialog.accept());
  await page.goto("/sops");
  await page.getByRole("tab", { name: "Admin workspace" }).click();
  await page.getByRole("button", { name: "Create SOP" }).click();
  await page.getByLabel("Template").selectOption("mapping");
  await page.getByRole("button", { name: "Apply template" }).click();
  await expect(page.locator(".sop-live-preview").getByRole("heading", { name: "Mapping Mission" })).toBeVisible();
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("Draft created.")).toBeVisible();
  await page.getByRole("button", { name: "Publish draft" }).click();
  await expect(page.getByText("Draft published deliberately.")).toBeVisible();
  await expect(page.getByText("Revision 2").first()).toBeVisible();
  const firstRevision = page.locator(".sop-revision-history li").filter({ hasText: "Revision 1" });
  await firstRevision.getByRole("button", { name: "Restore as new draft" }).click();
  await expect(page.getByText("Revision 1 restored as a new draft.")).toBeVisible();
  await page.getByLabel("Title").fill("Locally edited mapping mission");
  await page.getByRole("button", { name: "Save new draft revision" }).click();
  await expect(page.getByText(/Another administrator saved version 4/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
