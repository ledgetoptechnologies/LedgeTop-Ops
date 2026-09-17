import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function files(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? files(child) : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [child] : [];
  });
}

describe("project v2 canonical activation import graph", () => {
  it("keeps command/read/activation adapters unmounted from production entrypoints", () => {
    const worker = new URL("../src/worker/", import.meta.url);
    const forbidden = [
      "project-alpha-project-settlement-adapter",
      "project-alpha-project-read-settlement-adapter",
      "project-alpha-project-canonical-activation-adapter",
      "project-alpha-project-v2-command-producer",
    ];
    const adapters = new Set(forbidden.map(name => new URL(`${name}.ts`, worker).pathname));
    const offenders = files(worker).filter(file => !adapters.has(file.pathname)).flatMap(file => {
      const source = readFileSync(file, "utf8");
      return forbidden.filter(name => source.includes(name)).map(name => `${file.pathname} -> ${name}`);
    });
    expect(offenders).toEqual([]);
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
});
