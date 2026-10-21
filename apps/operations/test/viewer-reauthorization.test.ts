import { describe, expect, it } from "vitest";
import { parseViewerReauthorization, viewerReauthorizationFragment } from "../src/client/viewer-reauthorization";

const nonce = "n".repeat(32);

describe("Viewer reauthorization bounce", () => {
  it("keeps the popup path exactly as before", () => {
    const value = parseViewerReauthorization(`?state=${nonce}`);
    expect(value).toEqual({ kind: "valid", nonce, sameTab: false });
    expect(viewerReauthorizationFragment(value as { nonce: string; sameTab: boolean })).toBe(`reauthorize=${nonce}`);
  });

  it("echoes only an explicit single same-tab mode", () => {
    const value = parseViewerReauthorization(`?recoveryMode=same-tab&state=${nonce}`);
    expect(value).toEqual({ kind: "valid", nonce, sameTab: true });
    expect(new URLSearchParams(viewerReauthorizationFragment(value as { nonce: string; sameTab: boolean })))
      .toEqual(new URLSearchParams({ reauthorize: nonce, recoveryMode: "same-tab" }));
  });

  it("ignores ordinary visits and refuses anything ambiguous", () => {
    expect(parseViewerReauthorization("")).toEqual({ kind: "none" });
    expect(parseViewerReauthorization("?section=models")).toEqual({ kind: "none" });
    for (const search of [`?state=${nonce}&recoveryMode=`, `?state=${nonce}&recoveryMode=Same-Tab`, `?state=${nonce}&recoveryMode=same-tab&recoveryMode=same-tab`,
      `?state=${nonce}&state=${nonce}`, `?state=${"n".repeat(31)}`, `?state=${"n".repeat(129)}`, `?state=${nonce.slice(1)}%2F`, "?recoveryMode=same-tab", "?state="])
      expect(parseViewerReauthorization(search)).toEqual({ kind: "invalid" });
  });
});
