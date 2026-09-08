import { describe, expect, it } from "vitest";
import { resolvePortalBrand } from "../src/client/portal-brand";

describe("shared portal brand context", () => {
  it("uses the Drone Services division on the primary portal host", () => {
    expect(resolvePortalBrand("portal.ledgetopdroneservices.com")).toMatchObject({
      key: "drone-services", division: "Drone Services", shortName: "LTDS",
    });
  });

  it("uses the Technologies division on the alternate portal host", () => {
    expect(resolvePortalBrand("PORTAL.LEDGETOPTECHNOLOGIES.COM")).toMatchObject({
      key: "technologies", division: "Technologies", shortName: "LTT",
    });
  });

  it("lets the selected source override a mismatched host", () => {
    expect(resolvePortalBrand("portal.ledgetoptechnologies.com", "project-alpha:primary")).toMatchObject({
      key: "drone-services", division: "Drone Services", sourceId: "project-alpha:primary",
    });
    expect(resolvePortalBrand("portal.ledgetopdroneservices.com", "project-alpha:secondary")).toMatchObject({
      key: "technologies", division: "Technologies", sourceId: "project-alpha:secondary",
    });
  });

  it("does not guess a legal division for an unknown source or host", () => {
    expect(resolvePortalBrand("portal.example.test", "project-alpha:future")).toMatchObject({
      key: "generic", division: "Workspace", shortName: "Ledge Top", sourceId: null,
    });
    expect(resolvePortalBrand("portal.ledgetopdroneservices.com", "project-alpha:future")).toMatchObject({
      key: "generic", division: "Workspace", shortName: "Ledge Top", sourceId: null,
    });
  });
});
