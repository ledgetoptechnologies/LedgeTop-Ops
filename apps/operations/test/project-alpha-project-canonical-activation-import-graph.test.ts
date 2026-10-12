import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function files(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? files(child) : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [child] : [];
  });
}

describe("project v2 canonical activation import graph", () => {
  it("mounts the current chain through reviewed acceptance, private-admin and operational paths while keeping low-level adapters private", () => {
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
    const finalizerUrl = new URL("project-alpha-project-adoption-finalizer.ts", worker);
    const operationalRoutesUrl = new URL("project-alpha-project-adoption-operational-routes.ts", worker);
    const clientHubNativeManagement = new URL("client-hub-native-project-management.ts", worker).pathname;
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
      [finalizerUrl.pathname, new Set([
        "project-alpha-project-read-settlement-adapter",
        "project-alpha-project-canonical-activation-adapter",
        "project-alpha-project-v2-pending-dispatcher",
      ])],
      [clientHubNativeManagement, new Set([
        "project-alpha-project-v2-command-producer",
        "project-alpha-project-v2-pending-dispatcher",
        "project-alpha-project-read-settlement-adapter",
        "project-alpha-project-canonical-activation-adapter",
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
    expect(index).not.toContain("project-alpha-project-adoption-finalizer");
    const privateRoutes = readFileSync(privateAdminUrl, "utf8");
    expect(privateRoutes).toContain("app.use(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/*`, guard)");
    expect(privateRoutes).toContain("if (!enabled(c.env)) throw new HTTPException(404");
    expect(privateRoutes).toContain('if (!c.get("administrator")) throw new HTTPException(403');
    expect(privateRoutes).toContain('c.env.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED !== "true"');
    expect(privateRoutes).toContain('requireIdempotency(c.req.raw, input.commandId)');
    expect(readFileSync(finalizerUrl, "utf8")).toContain('env.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED !== "true"');
    const finalizerImporters = files(worker).filter(file => file.pathname !== finalizerUrl.pathname
      && readFileSync(file, "utf8").includes("project-alpha-project-adoption-finalizer"));
    expect(finalizerImporters.map(file => file.pathname).sort()).toEqual([
      privateAdmin, operationalRoutesUrl.pathname,
    ].sort());
    const operationalRoutes = readFileSync(operationalRoutesUrl, "utf8");
    for (const flag of ["OPERATIONAL", "REVIEW", "FINALIZATION"])
      expect(operationalRoutes).toContain(`env.PROJECT_ALPHA_PROJECT_ADOPTION_${flag}_ENABLED === "true"`);
    expect(operationalRoutes).toContain("requireEnabled(c.env)");
    expect(operationalRoutes).toContain("authenticateNativeStaffWithAdmissionVersion");
    expect(operationalRoutes).toContain("identity.verifiedAccessSubject !== principal.accessSubject");
    expect(operationalRoutes).toContain("role_id='role-owner' AND scope='global'");
    expect(operationalRoutes).toContain('sqlScope(c.env, principal, "integrations.manage")');
    expect(operationalRoutes).toContain("owner !== 1 || !integration.global || integration.deniedGlobal");
    expect(operationalRoutes).toContain("contextVersion(input, context)");
    expect(operationalRoutes).toContain("requireIdempotency(c.req.raw, input.commandId)");
    expect(operationalRoutes).toContain('exactStoredRelationship(c.env.OPS_DB, context, "command", input.commandId, input.reservationId)');
    expect(operationalRoutes).toContain("await finalizeProjectAlphaProjectAdoption(c.env, actor,");
    expect(operationalRoutes).toContain("await verify(c.env, c.get(\"principal\"), context); await currentActor(c)");
  });

  it("keeps the activation surface free of fetcher, connection, request, route, queue, and scheduler inputs", async () => {
    const module = await import("../src/worker/project-alpha-project-canonical-activation-adapter");
    expect(Object.keys(module)).toEqual(["activateProjectAlphaProjectV2Canonical"]);
    expect(module.activateProjectAlphaProjectV2Canonical.length).toBe(2);
  });

  it("keeps the command producer private and accepts only an optional atomic admission statement", async () => {
    const module = await import("../src/worker/project-alpha-project-v2-command-producer");
    expect(Object.keys(module)).toEqual(["planProjectAlphaProjectV2Command"]);
    expect(module.planProjectAlphaProjectV2Command.length).toBe(3);
  });

  it("keeps the queued dispatcher private and requires an injected transport", async () => {
    const module = await import("../src/worker/project-alpha-project-v2-pending-dispatcher");
    expect(Object.keys(module)).toEqual(["dispatchProjectAlphaProjectV2PendingCommand"]);
    expect(module.dispatchProjectAlphaProjectV2PendingCommand.length).toBe(4);
  });
});
