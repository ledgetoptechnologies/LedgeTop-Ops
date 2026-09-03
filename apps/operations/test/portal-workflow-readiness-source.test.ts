import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("portal workflow readiness source contract", () => {
  it("does not mirror unverifiable Client flags and keeps the endpoint read-only", () => {
    const operations = JSON.parse(read("../wrangler.jsonc"));
    for (const key of ["CLIENT_PORTAL_REQUEST_V2_ENABLED", "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED",
      "CLIENT_REQUEST_ATTACHMENTS_ENABLED", "CLIENT_DELEGATED_SHARES_ENABLED"])
      expect(operations.vars[key]).toBeUndefined();
    expect(operations.vars.CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS).toBeUndefined();
    const worker = read("../src/worker/index.ts");
    expect(worker).toContain('app.get("/api/admin/portal-workflow-readiness"');
    expect(worker).not.toContain('app.post("/api/admin/portal-workflow-readiness"');
    const readiness = read("../src/worker/portal-workflow-readiness.ts");
    expect(readiness).toContain('item("unverified"');
    expect(readiness).toContain("projectAccessAuthorityMutationsEnabled(env)");
    expect(readiness).not.toMatch(/SELECT\s+.*(?:email|subject|prefix|secret|recipient)/i);
  });

  it("keeps the portal-contact search threshold in the API capability and UI explanation", () => {
    const worker = read("../src/worker/client-hub-directory.ts");
    const client = read("../src/client/ClientDirectory.tsx");
    expect(worker).toContain("PORTAL_CONTACT_MINIMUM_QUERY_LENGTH = 3");
    expect(worker).toContain("portalContactMinimumQueryLength: PORTAL_CONTACT_MINIMUM_QUERY_LENGTH");
    expect(client).toContain("Portal contact records are searched after ${searchCapabilities.portalContactMinimumQueryLength} characters.");
  });
});
