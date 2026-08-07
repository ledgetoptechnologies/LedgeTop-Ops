import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("../src/worker/delivery", () => ({
  authorizeDeliveryFolderPrefix: mocks.authorize,
}));

import { listDeliveryFolderLocations } from "../src/worker/delivery-locations";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "staff-a",
  email: "staff@example.test",
  displayName: "Staff",
  accessSubject: "subject-a",
  projectAlphaUserId: null,
};

function environment(rows: Array<{ latitude: number; longitude: number }>) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const env = {
    DELIVERY_DB: {
      prepare(sql: string) {
        const call = { sql, binds: [] as unknown[] };
        calls.push(call);
        const statement = {
          bind(...binds: unknown[]) { call.binds = binds; return statement; },
          async all<T>() { return { results: rows as T[] }; },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("authorized Operations delivery location maps", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue("Jobs/Clients/Acme/Current/");
  });

  it("authorizes the exact folder before aggregating current non-trashed asset versions", async () => {
    const value = environment([
      { latitude: 44.5, longitude: -88.1 },
      { latitude: 44.5, longitude: -88.1 },
    ]);
    const result = await listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Acme/Current");
    expect(mocks.authorize).toHaveBeenCalledWith(value.env, principal, "Jobs/Clients/Acme/Current");
    expect(result).toEqual({
      points: [{ latitude: 44.5, longitude: -88.1, imageCount: 2 }],
      imageCount: 2,
      truncated: false,
    });
    expect(value.calls[0]?.binds).toEqual(["Jobs/Clients/Acme/Current/", 501]);
    for (const condition of [
      "trim(file.etag,'\"')=location.source_etag",
      "location.folder_prefix=?",
      "location.status='ready'",
      "tombstone.restored_at IS NULL",
    ]) expect(value.calls[0]?.sql).toContain(condition);
    expect(JSON.stringify(result)).not.toMatch(/source|key|etag/i);
  });

  it("does not query location rows when the assigned-folder authorization fails", async () => {
    const value = environment([{ latitude: 1, longitude: 2 }]);
    mocks.authorize.mockRejectedValue(new HTTPException(404, { message: "Folder not found" }));
    await expect(listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Other/"))
      .rejects.toMatchObject({ status: 404 });
    expect(value.calls).toHaveLength(0);
  });

  it("drops invalid aggregate rows instead of emitting or counting them", async () => {
    const value = environment([
      { latitude: 44.5, longitude: -88.1 },
      { latitude: 91, longitude: -88.1 },
      { latitude: Number.NaN, longitude: -88.1 },
    ]);
    await expect(listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Acme/Current"))
      .resolves.toEqual({
        points: [{ latitude: 44.5, longitude: -88.1, imageCount: 1 }],
        imageCount: 1,
        truncated: false,
      });
  });
});
