import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IncomingArchiveBrowser, type ArchiveLoader } from "../src/client/IncomingArchiveBrowser";

describe("IncomingArchiveBrowser static boundary", () => {
  it("renders unavailable while inactive without calling a loader or exposing file actions", () => {
    const loader = vi.fn<ArchiveLoader>();
    const html = renderToStaticMarkup(createElement(IncomingArchiveBrowser, { uploadId: "upload-one", active: false, loader }));
    expect(html).toContain("Archive unavailable");
    expect(html).not.toContain("download");
    expect(loader).not.toHaveBeenCalled();
  });
});
