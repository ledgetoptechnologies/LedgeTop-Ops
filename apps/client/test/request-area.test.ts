import { describe, expect, it } from "vitest";
import { validateRequestArea } from "../src/worker/client-portal/request-area";

const triangle = { type: "Polygon", coordinates: [[[-88.1, 44.5], [-88.0, 44.5], [-88.05, 44.6], [-88.1, 44.5]]] };

describe("client request map area", () => {
  it("accepts a closed, bounded single-ring polygon", () => {
    expect(validateRequestArea(triangle)).toEqual(triangle);
  });

  it("rejects open, self-intersecting, and out-of-bounds client geometry", () => {
    expect(() => validateRequestArea({ ...triangle, coordinates: [[[-88.1, 44.5], [-88.0, 44.5], [-88.05, 44.6]]] })).toThrow("invalid area");
    expect(() => validateRequestArea({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]] })).toThrow("invalid area");
    expect(() => validateRequestArea({ type: "Polygon", coordinates: [[[181, 0], [1, 1], [0, 1], [181, 0]]] })).toThrow("invalid area");
  });

  it("accepts bounded geometry beside the antimeridian but rejects a ring that crosses it", () => {
    const adjacent = { type: "Polygon", coordinates: [[[179.7, 10], [179.9, 10], [179.9, 10.2], [179.7, 10.2], [179.7, 10]]] };
    expect(validateRequestArea(adjacent)).toEqual(adjacent);
    expect(() => validateRequestArea({ type: "Polygon", coordinates: [[[179.9, 10], [-179.9, 10], [-179.9, 10.2], [179.9, 10.2], [179.9, 10]]] })).toThrow("invalid area");
  });
});
