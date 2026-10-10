import { describe, expect, it } from "vitest";
import { businessProjectHref, readBusinessProjectRoute } from "../src/client/business-project-route";
import type { ClientSummary } from "../src/client/ClientDirectory";

const client = {
  source_id: "project-alpha:primary",
  root_namespace: "business",
  route_kind: "organizations",
  public_id: "client-one",
} as ClientSummary;

describe("typed Client Hub business-project routes", () => {
  it("keeps a PA ID that resembles the former canonical prefix in the PA namespace", () => {
    expect(readBusinessProjectRoute("/clients/sources/project-alpha%3Aprimary/business/organizations/client-one/projects/pa/shared%3Aabc"))
      .toMatchObject({ projectOrigin: "pa", projectId: "shared:abc" });
    expect(readBusinessProjectRoute("/clients/sources/project-alpha%3Aprimary/business/organizations/client-one/projects/canonical/abc"))
      .toMatchObject({ projectOrigin: "canonical", projectId: "abc" });
  });

  it("emits explicit origins and treats legacy one-segment bookmarks as PA-only", () => {
    expect(businessProjectHref(client, "abc", "canonical", ""))
      .toBe("/clients/sources/project-alpha%3Aprimary/business/organizations/client-one/projects/canonical/abc");
    expect(readBusinessProjectRoute("/clients/sources/project-alpha%3Aprimary/business/organizations/client-one/projects/shared%3Aabc"))
      .toMatchObject({ projectOrigin: "pa", projectId: "shared:abc" });
    expect(readBusinessProjectRoute("/clients/sources/project-alpha%3Aprimary/business/organizations/client-one/projects/shared/abc"))
      .toEqual({ invalid: true });
  });
});
