import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerCreateBody } from "../src/client/viewer-provider-create";

const server = readFileSync(new URL("../../viewer/server/processingApi.js", import.meta.url), "utf8");
const creationRoute = server.split("router.post('/api/v1/processing/providers',")[1]?.split("router.patch('/api/v1/processing/providers/:id',")[0];

describe("provider creation matches the imported Viewer server", () => {
  it("sends exactly the keys accepted by the actual creation route, without legacy settings", () => {
    expect(creationRoute).toBeDefined();
    const match = creationRoute!.match(/onlyKeys\(b,\[([^\]]+)\]\)/);
    expect(match).not.toBeNull();
    const allowed = [...match![1]!.matchAll(/'([^']+)'/g)].map(value => value[1]);
    expect(allowed).toEqual(["displayName", "endpoint", "credential"]);
    const body = providerCreateBody(" Synthetic provider ", "https://synthetic.example", "synthetic-token");
    expect(Object.keys(body)).toEqual(allowed);
    expect(body.displayName).toBe("Synthetic provider");
    expect(body.credential).toEqual({ token: "synthetic-token" });
    for (const field of ["type", "enabled", "admissionLimit"]) expect(body).not.toHaveProperty(field);
    expect(creationRoute).toContain("providerType");
    expect(creationRoute).toContain("enabled:false");
  });
  it("omits credentials when none is supplied and wires the form to the bounded body", () => {
    expect(providerCreateBody("Synthetic", "https://synthetic.example", "")).toEqual({ displayName: "Synthetic", endpoint: "https://synthetic.example" });
    const panel = readFileSync(new URL("../src/client/ViewerProcessingPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("JSON.stringify(providerCreateBody(name, endpoint, token))");
    expect(panel).not.toContain("setProviderType");
  });
});
