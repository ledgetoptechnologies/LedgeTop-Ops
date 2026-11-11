import { describe, expect, it } from "vitest";
import { loadFailureText } from "@ltds/ui";

describe("load failure text", () => {
  it.each(["Not found", "Internal Server Error", "Request failed (502)", "Failed to fetch", "", null, undefined])(
    "replaces the bare failure %s with one readable sentence", message => {
      expect(loadFailureText(message)).toBe("This couldn't be loaded right now. Try again in a moment.");
    });

  it("uses the caller's sentence for a bare failure", () => {
    expect(loadFailureText("Not found", "The dashboard couldn't be loaded.")).toBe("The dashboard couldn't be loaded.");
  });

  it("keeps a specific server message", () => {
    expect(loadFailureText("Project Alpha is not connected yet.")).toBe("Project Alpha is not connected yet.");
  });
});
