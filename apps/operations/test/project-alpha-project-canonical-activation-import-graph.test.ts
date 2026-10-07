import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function files(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? files(child) : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [child] : [];
  });
}

describe("project v2 canonical activation import graph", () => {
  it("mounts the current chain only through the dedicated acceptance route and keeps the legacy settlement adapter private", () => {
    const worker = new URL("../src/worker/", import.meta.url);
    const forbidden = [
      "project-alpha-project-settlement-adapter",
      "project-alpha-project-read-settlement-adapter",
      "project-alpha-project-canonical-activation-adapter",
      "project-alpha-project-v2-command-producer",
      "project-alpha-project-v2-pending-dispatcher",
    ];
    const adapters = new Set(forbidden.map(name => new URL(`${name}.ts`, worker).pathname));
    const acceptance = new URL("project-alpha-project-v2-acceptance-routes.ts", worker).pathname;
    const privateAdminUrl = new URL("project-alpha-private-admin-routes.ts", worker);
    const privateAdmin = privateAdminUrl.pathname;
    const acceptedImports = new Map<string, ReadonlySet<string>>([
      [acceptance, new Set([
      "project-alpha-project-v2-command-producer",
      "project-alpha-project-v2-pending-dispatcher",
      "project-alpha-project-read-settlement-adapter",
      "project-alpha-project-canonical-activation-adapter",
      ])],
      [privateAdmin, new Set([
        "project-alpha-project-read-settlement-adapter",
        "project-alpha-project-canonical-activation-adapter",
        "project-alpha-project-v2-pending-dispatcher",
      ])],
    ]);
    const offenders = files(worker).filter(file => !adapters.has(file.pathname)).flatMap(file => {
      const source = readFileSync(file, "utf8");
      const allowed = acceptedImports.get(file.pathname) ?? new Set<string>();
      return forbidden.filter(name => source.includes(name)
        && !allowed.has(name))
        .map(name => `${file.pathname} -> ${name}`);
    });
    expect(offenders).toEqual([]);
    const index = readFileSync(new URL("index.ts", worker), "utf8");
    expect(index).toContain("project-alpha-project-v2-acceptance-routes");
    for (const adapter of forbidden) expect(index).not.toContain(`./${adapter}`);
    const privateRoutes = readFileSync(privateAdminUrl, "utf8");
    expect(privateRoutes).toContain("app.use(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/*`, guard)");
    expect(privateRoutes).toContain("if (!enabled(c.env)) throw new HTTPException(404");
    expect(privateRoutes).toContain('if (!c.get("administrator")) throw new HTTPException(403');
  });

  it("keeps the activation surface free of fetcher, connection, request, route, queue, and scheduler inputs", async () => {
    const module = await import("../src/worker/project-alpha-project-canonical-activation-adapter");
    expect(Object.keys(module)).toEqual(["activateProjectAlphaProjectV2Canonical"]);
    expect(module.activateProjectAlphaProjectV2Canonical.length).toBe(2);
  });

  it("keeps the command producer private and without a transport argument", async () => {
    const module = await import("../src/worker/project-alpha-project-v2-command-producer");
    expect(Object.keys(module)).toEqual(["planProjectAlphaProjectV2Command"]);
    expect(module.planProjectAlphaProjectV2Command.length).toBe(2);
  });

  it("keeps the queued dispatcher private and requires an injected transport", async () => {
    const module = await import("../src/worker/project-alpha-project-v2-pending-dispatcher");
    expect(Object.keys(module)).toEqual(["dispatchProjectAlphaProjectV2PendingCommand"]);
    expect(module.dispatchProjectAlphaProjectV2PendingCommand.length).toBe(4);
  });
});
