import { describe, expect, it } from "vitest";
import { resolveDivisionAssociation, resolveShareExpiration } from "../src/worker/delivery";

describe("delivery share scope inference", () => {
  it("uses the most specific folder association", () => {
    expect(resolveDivisionAssociation("jobs/2026/client/edited/", [
      { division_id: "north", r2_prefix: "jobs/2026/" },
      { division_id: "chippewa", r2_prefix: "jobs/2026/client/" },
    ])).toBe("chippewa");
  });

  it("returns no division for an unassociated folder", () => {
    expect(resolveDivisionAssociation("jobs/2026/other/", [
      { division_id: "chippewa", r2_prefix: "jobs/2026/client/" },
    ])).toBeNull();
  });

  it("rejects equally specific associations across divisions", () => {
    expect(() => resolveDivisionAssociation("jobs/2026/client/edited/", [
      { division_id: "chippewa", r2_prefix: "jobs/2026/client/" },
      { division_id: "madison", r2_prefix: "jobs/2026/client/" },
    ])).toThrow("multiple divisions");
  });
});

describe("delivery share expiration", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");

  it("defaults to a non-expiring share", () => {
    expect(resolveShareExpiration(undefined, 90, now)).toBeNull();
    expect(resolveShareExpiration(null, 90, now)).toBeNull();
  });

  it("normalizes a valid explicit expiration", () => {
    expect(resolveShareExpiration("2026-08-01T12:00:00Z", 90, now)).toBe("2026-08-01T12:00:00.000Z");
  });

  it("rejects expired and over-limit dates", () => {
    expect(() => resolveShareExpiration("2026-07-15T12:00:00Z", 90, now)).toThrow("within 90 days");
    expect(() => resolveShareExpiration("2027-01-01T12:00:00Z", 90, now)).toThrow("within 90 days");
  });
});
