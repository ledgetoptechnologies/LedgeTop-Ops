import { describe, expect, it } from "vitest";
import { requestAreaKml, requestAreaKmlFilename } from "../src/worker/request-area-kml";

describe("request-area KML export", () => {
  it("exports only the bounded stored polygon and points with escaped labels", () => {
    const kml = requestAreaKml({
      title: "School & field <review>",
      revisionLabel: "Original client submission",
      areaGeoJson: JSON.stringify({
        type: "Polygon",
        coordinates: [[[-88, 44], [-87.9, 44], [-87.9, 44.1], [-88, 44]]],
      }),
      poiPointsJson: JSON.stringify([{ longitude: -87.95, latitude: 44.05, label: "Gate & staging" }]),
    });

    expect(kml).toContain("School &amp; field &lt;review&gt;");
    expect(kml).toContain("Gate &amp; staging");
    expect(kml).toContain("-88,44,0 -87.9,44,0 -87.9,44.1,0 -88,44,0");
    expect(kml).not.toContain("<script");
  });

  it("fails closed for malformed or unbounded stored geometry", () => {
    expect(requestAreaKml({ title: "Bad", revisionLabel: "Original", areaGeoJson: "not-json", poiPointsJson: null })).toBeNull();
    expect(requestAreaKml({
      title: "Bad",
      revisionLabel: "Original",
      areaGeoJson: JSON.stringify({ type: "Polygon", coordinates: [[[181, 44], [1, 1], [2, 2], [181, 44]]] }),
      poiPointsJson: null,
    })).toBeNull();
  });

  it("does not create an empty export and sanitizes the attachment filename", () => {
    expect(requestAreaKml({ title: "Empty", revisionLabel: "Original", areaGeoJson: null, poiPointsJson: "[]" })).toBeNull();
    expect(requestAreaKmlFilename("../Client / Map 🚁", "effective")).toBe("Client-Map-effective-work-area.kml");
  });
});
