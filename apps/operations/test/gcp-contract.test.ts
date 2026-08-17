import { describe, expect, it } from "vitest";
import { formatGcpDistance, formatGcpElevation, gcpElevationDisplayValue, gcpElevationToMeters, MAX_GCP_IMPORT_BYTES, validateGcpImportSize } from "../src/client/gcp-contract";

describe("GCP display units", () => {
  it("fails fast before reading interchange files over the Viewer 2 MiB cap", () => {
    expect(validateGcpImportSize(MAX_GCP_IMPORT_BYTES)).toBeNull();
    expect(validateGcpImportSize(MAX_GCP_IMPORT_BYTES + 1)).toMatch(/2 MiB/);
    expect(validateGcpImportSize(Number.NaN)).toMatch(/2 MiB/);
  });
  it("keeps canonical metric values while defaulting display to imperial", () => {
    expect(formatGcpElevation(243.84, "imperial")).toBe("800.00 ft");
    expect(formatGcpElevation(243.84, "metric")).toBe("243.84 m");
    expect(formatGcpDistance(30.48, "imperial")).toBe("100 ft");
    expect(formatGcpDistance(30.48, "metric")).toBe("30 m");
    expect(gcpElevationDisplayValue(243.84,"imperial")).toBeCloseTo(800);
    expect(gcpElevationToMeters(800,"imperial")).toBeCloseTo(243.84);
    expect(gcpElevationDisplayValue(243.84,"metric")).toBe(243.84);
    expect(gcpElevationToMeters(243.84,"metric")).toBe(243.84);
  });

  it("uses larger units for longer image-to-GCP distances", () => {
    expect(formatGcpDistance(1609.344, "imperial")).toBe("1.00 mi");
    expect(formatGcpDistance(1500, "metric")).toBe("1.50 km");
    expect(formatGcpDistance(null, "imperial")).toBe("Distance unavailable");
  });
});
