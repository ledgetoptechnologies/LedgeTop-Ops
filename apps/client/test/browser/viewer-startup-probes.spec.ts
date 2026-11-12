import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const portalOrigin = "https://portal.paired.test";
const viewerOrigin = "https://viewer.paired.test";
const clientDist = fileURLToPath(new URL("../../dist/client/", import.meta.url));
const grant = "11111111-1111-4111-8111-111111111111";
const workspace = { id: "workspace-b", rootType: "organization", rootPublicId: "org-synthetic", displayName: "Synthetic account", resourceMode: "native", sourceId: "project-alpha:synthetic" };
const features = {
  directory: { state: "available", reason: "authorized_capability" },
  deliveries: { state: "available", reason: "resource_authorization_required" },
  ...Object.fromEntries(["serviceRequests", "feedback", "models", "team", "billing"].map(name => [name, { state: "not_supported", reason: "source_not_supported" }])),
};

/** All requests are intercepted; this verifies full-page launch behavior only. */
test("direct Viewer route waits for an explicit click and opens the top-level session page", async ({ page }) => {
  let sessionRequests = 0;
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === viewerOrigin) {
      if (url.pathname.startsWith("/session/")) return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Full-page Viewer</title>" });
      return route.fulfill({ status: 404, body: "Unsupported synthetic child endpoint" });
    }
    if (url.origin !== portalOrigin) return route.fulfill({ status: 404, body: "External network disabled" });
    if (url.pathname.startsWith("/api/client/")) {
      if (url.pathname === "/api/client/session") return route.fulfill({ json: { account: { id: "", displayName: "Client portal" }, capabilities: { workspaceHierarchyV2: true } } });
      if (url.pathname === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: [workspace] } });
      if (url.pathname === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({ json: { workspace, contextVersion: "synthetic-context", features,
        capabilities: { directoryRead: true, deliveryView: true, requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false } } });
      if (url.pathname === "/api/client/v2/workspaces/workspace-b/viewer") return route.fulfill({ json: { workspaceId: workspace.id, contextVersion: "synthetic-viewer", items: [], nextCursor: null } });
      if (request.method() === "POST" && url.pathname === "/api/client/v2/workspaces/workspace-b/viewer/grant-task/tasks/task-1/session") {
        sessionRequests += 1;
        return route.fulfill({ status: 201, json: { modelId: "model-direct", grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
          redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${grant}` } });
      }
      return route.fulfill({ status: 404, json: { error: "Unsupported synthetic parent endpoint" } });
    }
    const asset = url.pathname.startsWith("/assets/");
    const file = asset ? resolve(clientDist, `.${decodeURIComponent(url.pathname)}`) : resolve(clientDist, "index.html");
    if (!file.startsWith(`${resolve(clientDist)}${sep}`)) return route.fulfill({ status: 400 });
    return route.fulfill({ contentType: extname(file) === ".css" ? "text/css" : extname(file) === ".js" ? "text/javascript" : "text/html", body: await readFile(file) });
  });
  await page.goto(`${portalOrigin}/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b`);
  await expect(page.getByRole("button", { name: "Open 3D model" })).toBeVisible();
  expect(sessionRequests).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
  const popupWait = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open 3D model" }).click();
  const popup = await popupWait;
  await expect(popup).toHaveURL(`${viewerOrigin}/session/${grant}`);
  await expect(popup.locator("iframe")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(sessionRequests).toBe(1);
});
