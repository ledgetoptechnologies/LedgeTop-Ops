import { describe, expect, it } from "vitest";
import { firstAccessDedupeKey } from "../src/worker/notifications";

describe("delivery notification recording", () => {
  it("uses one stable first-access key per share", () => {
    expect(firstAccessDedupeKey("share-123")).toBe("first_access:share-123");
  });
});
