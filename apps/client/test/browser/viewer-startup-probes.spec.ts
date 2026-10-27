import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const portalOrigin = "https://portal.paired.test";
const viewerOrigin = "https://viewer.paired.test";
const clientDist = fileURLToPath(new URL("../../dist/client/", import.meta.url));
const classicScript = fileURLToPath(new URL("../../../viewer/public/viewer-startup-diagnostics.js", import.meta.url));
const grant = "11111111-1111-4111-8111-111111111111";
const workspace = { id: "workspace-b", rootType: "organization", rootPublicId: "org-synthetic", displayName: "Synthetic account", resourceMode: "native", sourceId: "project-alpha:synthetic" };
const features = {
  directory: { state: "available", reason: "authorized_capability" },
  deliveries: { state: "available", reason: "resource_authorization_required" },
  ...Object.fromEntries(["serviceRequests", "feedback", "models", "team", "billing"].map(name => [name, { state: "not_supported", reason: "source_not_supported" }])),
};

/**
 * The built Client entry retains its real StrictMode, direct session handoff,
 * RenewableViewerShell and ViewerEmbed. Every request is intercepted; HTTPS
 * origins provide real browser postMessage origin checks, not real TLS/Access.
 * Only APIs and child HTML/module are fixtures. The classic script is exact source.
 */
test("direct client Viewer observes its shell while the module is still pending, before iframe load", async ({ page }) => {
  let releaseModule!: () => void;
  const moduleGate = new Promise<void>(resolveGate => { releaseModule = resolveGate; });
  let moduleRequested = false, classicRequested = false, sessionRequests = 0, redemptionRequests = 0;
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === viewerOrigin) {
      if (url.pathname === `/session/${grant}`) {
        // Make the first mount probe arrive before the child listener exists.
        await new Promise(resolveDelay => setTimeout(resolveDelay, 350));
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><meta charset=\"utf-8\"><script src=\"/viewer-startup-diagnostics.js\"></script><script type=\"module\" src=\"/pending-module.js\"></script>" });
      }
      if (url.pathname === "/viewer-startup-diagnostics.js") {
        classicRequested = true;
        return route.fulfill({ contentType: "text/javascript", body: await readFile(classicScript) });
      }
      if (url.pathname === "/pending-module.js") {
        moduleRequested = true;
        await moduleGate;
        // A failing assertion may close the page before cleanup releases this route.
        return route.fulfill({ contentType: "text/javascript", body: "// Synthetic module intentionally does not redeem or report ready." }).catch(() => {});
      }
      if (url.pathname === "/api/v1/sessions/redeem") redemptionRequests += 1;
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
  try {
    // load waits for subframes; it must remain pending in this regression.
    await page.goto(`${portalOrigin}/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => moduleRequested && classicRequested).toBe(true);
    const stage = page.locator(".ltds-viewer-stage");
    await expect(stage).toHaveAttribute("data-viewer-startup-phase", "shell-loaded", { timeout: 4_000 });
    await expect(stage).toHaveAttribute("data-viewer-startup-sequence", "1");
    await expect(stage).toHaveAttribute("data-viewer-startup-stages", JSON.stringify(["shell-loaded"]));
    await expect(stage).toHaveAttribute("data-viewer-frame-loads", "0");
    await expect(stage).toHaveAttribute("aria-busy", "true");
    expect(sessionRequests).toBe(1);
    expect(redemptionRequests).toBe(0);
    expect(moduleRequested).toBe(true);
  } finally {
    releaseModule();
  }
});
