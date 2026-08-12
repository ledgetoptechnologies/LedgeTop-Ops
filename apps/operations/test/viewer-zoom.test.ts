import { describe, expect, it } from "vitest";
import { pointerAnchoredOffset } from "../src/client/viewer-zoom";

describe("pointer anchored viewer zoom", () => {
  it("keeps an off-centre pointer fixed while zooming", () => {
    const offset = pointerAnchoredOffset(1, 1.18, { x: 0, y: 0 }, { x: -200, y: 100 });
    expect(offset.x).toBeCloseTo(36);
    expect(offset.y).toBeCloseTo(-18);
  });

  it("resets panning when returning to the fitted scale", () => {
    expect(pointerAnchoredOffset(1.18, 1, { x: 36, y: -18 }, { x: -200, y: 100 }))
      .toEqual({ x: 0, y: 0 });
  });
});
