import { describe, expect, it } from "vitest";
import { buildNavigationDestination } from "@ltds/shared";

describe("external navigation destinations", () => {
  it("uses a point exactly and encodes safe Google and Apple web links", () => {
    const destination = buildNavigationDestination({
      geometry: { type: "Point", coordinates: [-88.1234567, 44.7654321] },
      label: "North field & launch",
    });
    expect(destination).toMatchObject({
      longitude: -88.1234567,
      latitude: 44.7654321,
      coordinateSource: "point",
      label: "North field & launch",
    });
    expect(destination?.googleMapsUrl).toBe(
      "https://www.google.com/maps/search/?api=1&query=44.765432%2C-88.123457",
    );
    expect(destination?.appleMapsUrl).toContain("ll=44.765432%2C-88.123457");
    expect(destination?.appleMapsUrl).toContain("q=North%20field%20%26%20launch");
    expect(destination?.googleMapsUrl).not.toMatch(/token|mapbox|r2/i);
  });

  it("uses deterministic representative points for multipoint and area geometry", () => {
    const multipoint = buildNavigationDestination({
      geometry: { type: "MultiPoint", coordinates: [[-89, 44], [-87, 46]] },
    });
    expect(multipoint).toMatchObject({ longitude: -89, latitude: 44, coordinateSource: "multipoint_representative" });

    const polygon = buildNavigationDestination({
      geometry: {
        type: "Polygon",
        coordinates: [[[-90, 43], [-86, 43], [-87, 47], [-90, 43]]],
      },
    });
    expect(polygon?.coordinateSource).toBe("area_representative");
    expect([[-90, 43], [-86, 43], [-87, 47]]).toContainEqual([polygon?.longitude, polygon?.latitude]);

    const antimeridian = buildNavigationDestination({
      geometry: { type: "MultiPoint", coordinates: [[179, 10], [-179, 12]] },
    });
    expect([[179, 10], [-179, 12]]).toContainEqual([antimeridian?.longitude, antimeridian?.latitude]);

    const disjoint = buildNavigationDestination({
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[10, 10], [11, 10], [10, 11], [10, 10]]],
          [[[80, 40], [81, 40], [80, 41], [80, 40]]],
        ],
      },
    });
    expect([[10, 10], [11, 10], [10, 11], [80, 40], [81, 40], [80, 41]])
      .toContainEqual([disjoint?.longitude, disjoint?.latitude]);
  });

  it("falls back to a stored selected point and rejects invalid coordinates", () => {
    expect(buildNavigationDestination({ latitude: 44.5, longitude: -88.1, label: "Rural parcel" }))
      .toMatchObject({ coordinateSource: "fallback_point", label: "Rural parcel" });
    expect(buildNavigationDestination({ latitude: 200, longitude: -88.1 })).toBeNull();
  });
});
