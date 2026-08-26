import { describe, expect, it } from "vitest";
import { deliveryViewCountText } from "../src/client/delivery-view-count";

describe("Delivery current-view item count", () => {
  it("counts each immediate folder once, without adding its descendants", () => {
    const items = [
      { prefix: "Jobs/Clients/Acme/Edited/", files: [{ id: "nested-photo" }], itemCount: 900, fileCount: 800 },
      { prefix: "Jobs/Clients/Acme/Originals/", folders: [{ prefix: "nested/" }], itemCount: 300 },
      ...Array.from({ length: 40 }, (_, id) => ({ id, prefix: undefined })),
    ];
    expect(deliveryViewCountText({ items })).toBe("42 items · 2 folders · 40 files");
  });

  it("counts only the filtered search result list", () => {
    expect(deliveryViewCountText({
      items: [{ prefix: "Jobs/Clients/Acme/Edited/" }, {}], searching: true,
    })).toBe("2 matching items · 1 folder · 1 file");
    expect(deliveryViewCountText({ items: [], searching: true })).toBe("0 matching items · 0 folders · 0 files");
  });

  it("marks incomplete folder pages and search results as loaded", () => {
    expect(deliveryViewCountText({ items: [{ prefix: "child/" }, {}, {}], partial: true }))
      .toBe("3 items loaded · 1 folder · 2 files");
    expect(deliveryViewCountText({ items: [{}], searching: true, partial: true }))
      .toBe("1 matching item loaded · 0 folders · 1 file");
  });

  it("does not advertise cached or old-query counts while loading or after failure", () => {
    const items = [{ prefix: "old/" }, {}];
    expect(deliveryViewCountText({ items, loading: true })).toBe("Loading folder items…");
    expect(deliveryViewCountText({ items, searching: true, loading: true })).toBe("Updating search results…");
    expect(deliveryViewCountText({ items, error: true })).toBe("Item count unavailable. Reload this view to try again.");
  });

  it("uses readable numbers and accurate singular and empty labels", () => {
    expect(deliveryViewCountText({ items: [] })).toBe("0 items · 0 folders · 0 files");
    expect(deliveryViewCountText({ items: [{}] })).toBe("1 item · 0 folders · 1 file");
    expect(deliveryViewCountText({ items: [{ kind: "folder" }] })).toBe("1 item · 1 folder · 0 files");
    expect(deliveryViewCountText({ items: Array.from({ length: 1200 }, () => ({})) }))
      .toBe("1,200 items · 0 folders · 1,200 files");
  });
});
