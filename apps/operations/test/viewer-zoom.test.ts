import { describe, expect, it } from "vitest";
import { constrainViewerOffset, pointerAnchoredOffset } from "../src/client/viewer-zoom";

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

  it("keeps the scaled image from panning out of the media stage", () => {
    expect(constrainViewerOffset(2, { x: 999, y: -999 }, { width: 800, height: 600 }))
      .toEqual({ x: 400, y: -300 });
    expect(constrainViewerOffset(1, { x: 20, y: -20 }, { width: 800, height: 600 }))
      .toEqual({ x: 0, y: 0 });
  });
});
