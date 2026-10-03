import { describe, expect, it } from "vitest";
import { decodeProjectAlphaApiV2SyncCursor, encodeProjectAlphaApiV2SyncCursor,
  type ProjectAlphaApiV2SyncCursorPayload } from "../src/worker/project-alpha-api-v2-sync-cursor";

const env = { OPERATIONS_SESSION_SECRET: "api-v2-cursor-test-secret-with-more-than-32-characters" };
const payload: ProjectAlphaApiV2SyncCursorPayload = {
  v: 1, sourceId: "project-alpha:primary", surface: "directory", limit: 50,
  sourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  applicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  historyEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", authorizationGeneration: "7",
  cursor: "client:dddddddddddddddddddddddddddddddd", expires: Date.now() + 60_000,
};
const expected = { sourceId: payload.sourceId, surface: payload.surface, limit: payload.limit } as const;

describe("Project Alpha API-v2 opaque continuation tokens", () => {
  it("round-trips an encrypted actor-bound cursor without exposing upstream IDs", async () => {
    const token = await encodeProjectAlphaApiV2SyncCursor(env, "staff-a", payload);
    expect(token).not.toContain(payload.cursor);
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-a", token, expected))
      .resolves.toEqual(payload);
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-b", token, expected)).rejects.toThrow("invalid");
  });

  it("rejects tampering, expiry, and mismatched source, surface, or limit", async () => {
    const token = await encodeProjectAlphaApiV2SyncCursor(env, "staff-a", payload);
    const changed = token[0] === "A" ? "B" : "A";
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-a", changed + token.slice(1), expected)).rejects.toThrow("invalid");
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-a", token,
      { ...expected, sourceId: "project-alpha:secondary" })).rejects.toThrow("stale");
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-a", token,
      { ...expected, surface: "projects" })).rejects.toThrow("stale");
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-a", token,
      { ...expected, limit: 100 })).rejects.toThrow("stale");
    const expired = await encodeProjectAlphaApiV2SyncCursor(env, "staff-a", { ...payload, expires: 100 });
    await expect(decodeProjectAlphaApiV2SyncCursor(env, "staff-a", expired, expected, 101)).rejects.toThrow("stale");
  });
});
