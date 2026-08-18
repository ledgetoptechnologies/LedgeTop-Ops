import { describe, expect, it } from "vitest";
import routesSource from "../src/worker/client-portal/routes.ts?raw";

describe("client Viewer model grant authorization query", () => {
  it("uses a semi-join so overlapping project and task grants cannot duplicate a model", () => {
    const route = routesSource.slice(
      routesSource.indexOf('router.get("/projects/:projectId/models"'),
      routesSource.indexOf("function viewerShareAuthorization"),
    );
    expect(route).toContain("AND EXISTS (SELECT 1 FROM viewer_client_grants viewer_grant");
    expect(route).not.toMatch(/JOIN viewer_client_grants viewer_grant ON/);
    expect(route).toContain("viewer_grant.scope_type='project'");
    expect(route).toContain("viewer_grant.scope_type='task'");
  });
});
