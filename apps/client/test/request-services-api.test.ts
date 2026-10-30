import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInquiries } from "../src/client/request-services-api";

function answer(status: number, body: unknown = { error: "Unavailable" }) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("general request history", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([403, 404, 405])("shows nothing when it isn't offered to this client (%i)", async status => {
    const fetch = answer(status);
    await expect(loadInquiries()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/client/inquiries", expect.objectContaining({ cache: "no-store" }));
  });

  it.each([401, 500, 503])("reports a failure it can't explain away (%i)", async status => {
    answer(status);
    await expect(loadInquiries()).rejects.toMatchObject({ status });
  });

  it("lists the client's requests newest first", async () => {
    answer(200, { inquiries: [
      { id: "a", kind: "website", title: "Older", details: "x", location: null, status: "received", createdAt: "2026-10-29T12:00:00Z" },
      { id: "b", kind: "drone", title: "Newer", details: "y", location: null, status: "under_review", createdAt: "2026-10-30T12:00:00Z" },
    ] });
    expect((await loadInquiries())?.map(item => item.id)).toEqual(["b", "a"]);
  });
});
