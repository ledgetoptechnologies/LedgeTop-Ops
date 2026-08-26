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

  it.each([
    {}, { latitude: null, longitude: null },
    { latitude: null, longitude: -88 }, { latitude: 44, longitude: null },
    { latitude: undefined, longitude: -88 }, { latitude: 44, longitude: undefined },
  ])("does not invent a destination for missing coordinates: %j", input => {
    expect(buildNavigationDestination(input)).toBeNull();
  });

  it.each([
    [null, null], [null, 44], [-88, null], [undefined, undefined],
    ["-88", "44"], ["", ""], [false, false], [true, true], [[], []],
    [{}, {}], [NaN, 44], [-88, Infinity], [181, 44], [-88, -91],
  ])("rejects malformed geometry ordinates: %j", (longitude, latitude) => {
    for (const type of ["Point", "MultiPoint", "Polygon", "MultiPolygon"] as const) {
      const point = [longitude, latitude];
      const coordinates = type === "Point" ? point : type === "MultiPoint" ? [point]
        : type === "Polygon" ? [[point]] : [[[point]]];
      expect(buildNavigationDestination({ geometry: { type, coordinates } })).toBeNull();
    }
  });

  it("preserves genuine numeric zero for stored and geometric locations", () => {
    for (const input of [
      { latitude: 0, longitude: 0 },
      { geometry: { type: "Point" as const, coordinates: [0, 0] }, latitude: null, longitude: null },
    ]) {
      const destination = buildNavigationDestination(input);
      expect(destination).toMatchObject({ latitude: 0, longitude: 0 });
      expect(destination?.googleMapsUrl).toContain("query=0.000000%2C0.000000");
    }
  });

  it("uses valid geometry despite missing fallback and valid fallback despite invalid geometry", () => {
    expect(buildNavigationDestination({
      geometry: { type: "MultiPoint", coordinates: [[null, null], [-88, 44]] },
      latitude: null, longitude: null,
    })).toMatchObject({ latitude: 44, longitude: -88, coordinateSource: "multipoint_representative" });
    expect(buildNavigationDestination({
      geometry: { type: "Point", coordinates: [null, null] }, latitude: 44, longitude: -88,
    })).toMatchObject({ latitude: 44, longitude: -88, coordinateSource: "fallback_point" });
  });
});
