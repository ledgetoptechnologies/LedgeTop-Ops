import { describe, expect, it, vi } from "vitest";
import { executeCreateAttempt, executeProfileAttempt, executeRelationshipAttempt,
  type FrozenCreateAttempt, type FrozenDirectoryRequest } from "../src/client/NativeDirectoryProfileAttempts";

const mutationId = "11111111-1111-4111-8111-111111111111";
const admission: FrozenDirectoryRequest = { path: "/create-admissions", method: "POST", mutationId,
  body: '{"kind":"client","mutationId":"11111111-1111-4111-8111-111111111111","name":"Frozen"}' };
const write: FrozenDirectoryRequest = { path: "/standalone-clients", method: "POST", mutationId,
  body: '{"mutationId":"11111111-1111-4111-8111-111111111111","name":"Frozen"}' };
const attempt: FrozenCreateAttempt = { mutationId, phase: "admission", sourceIds: ["project-alpha:primary"], admission, write };
const profileResult = { status: "pending", recordId: mutationId, kind: "client", version: 1, replayed: false,
  destinations: [{ sourceId: "project-alpha:primary", state: "pending" }] };

describe("native Directory frozen mutation attempts", () => {
  it("retries an uncertain admission byte-for-byte before advancing to one create", async () => {
    const calls: FrozenDirectoryRequest[] = [], entered: FrozenCreateAttempt[] = [];
    let reject = true;
    const request = vi.fn(async (value: FrozenDirectoryRequest) => {
      calls.push(value);
      if (value.path === admission.path && reject) { reject = false; throw new TypeError("network"); }
      return value.path === admission.path ? { status: "prepared" } : profileResult;
    });
    await expect(executeCreateAttempt(attempt, request, { recordId: mutationId, kind: "client", version: 1 }, value => entered.push(value)))
      .rejects.toThrow("network");
    await expect(executeCreateAttempt(attempt, request, { recordId: mutationId, kind: "client", version: 1 }, value => entered.push(value)))
      .resolves.toEqual(profileResult);
    expect(calls).toEqual([admission, admission, write]);
    expect(calls[0]!.body).toBe(calls[1]!.body);
    expect(calls[0]!.mutationId).toBe(calls[1]!.mutationId);
    expect(entered).toEqual([{ ...attempt, phase: "write" }]);
  });

  it("never re-prepares a consumed admission after the create response becomes uncertain", async () => {
    const calls: FrozenDirectoryRequest[] = [], entered: FrozenCreateAttempt[] = [];
    let rejectWrite = true;
    const request = vi.fn(async (value: FrozenDirectoryRequest) => {
      calls.push(value);
      if (value.path === admission.path) return { status: "prepared" };
      if (rejectWrite) { rejectWrite = false; throw new TypeError("network"); }
      return { ...profileResult, replayed: true };
    });
    await expect(executeCreateAttempt(attempt, request, { recordId: mutationId, kind: "client", version: 1 }, value => entered.push(value)))
      .rejects.toThrow("network");
    const writePhase = entered[0]!;
    await executeCreateAttempt(writePhase, request, { recordId: mutationId, kind: "client", version: 1 }, value => entered.push(value));
    expect(calls).toEqual([admission, write, write]);
    expect(calls[1]).toEqual(calls[2]);
    expect(entered).toHaveLength(1);
  });

  it("keeps profile and relationship retries byte-identical", async () => {
    const profileRequest = { ...write, method: "PATCH" as const };
    const profileCalls: FrozenDirectoryRequest[] = [];
    let failProfile = true;
    const requestProfile = async (value: FrozenDirectoryRequest) => {
      profileCalls.push(value);
      if (failProfile) { failProfile = false; throw new Error("409 after commit"); }
      return { ...profileResult, version: 2, replayed: true };
    };
    await expect(executeProfileAttempt(profileRequest, requestProfile, { recordId: mutationId, kind: "client", version: 2 })).rejects.toThrow();
    await executeProfileAttempt(profileRequest, requestProfile, { recordId: mutationId, kind: "client", version: 2 });
    expect(profileCalls).toEqual([profileRequest, profileRequest]);

    const relationshipRequest = { ...write, path: "/relationship" }, relationshipCalls: FrozenDirectoryRequest[] = [];
    let failRelationship = true;
    const requestRelationship = async (value: FrozenDirectoryRequest) => {
      relationshipCalls.push(value);
      if (failRelationship) { failRelationship = false; throw new Error("invalid response"); }
      return { status: "written", mutationId, relationshipVersion: 3, replayed: true,
        destinations: [{ sourceId: "project-alpha:primary", state: "acknowledged" }] };
    };
    await expect(executeRelationshipAttempt(relationshipRequest, requestRelationship,
      { mutationId, relationshipVersion: 3 })).rejects.toThrow();
    await executeRelationshipAttempt(relationshipRequest, requestRelationship, { mutationId, relationshipVersion: 3 });
    expect(relationshipCalls).toEqual([relationshipRequest, relationshipRequest]);
  });

  it("rejects malformed or mismatched successful responses as unresolved", async () => {
    await expect(executeCreateAttempt(attempt, async value => value.path === admission.path
      ? { status: "prepared", unexpected: true } : profileResult,
    { recordId: mutationId, kind: "client", version: 1 }, () => undefined)).rejects.toThrow("admission response");
    await expect(executeProfileAttempt(write, async () => ({}),
      { recordId: mutationId, kind: "client", version: 1 })).rejects.toThrow("could not be verified");
    await expect(executeProfileAttempt(write, async () => ({ ...profileResult, recordId: "different" }),
      { recordId: mutationId, kind: "client", version: 1 })).rejects.toThrow("could not be verified");
    await expect(executeRelationshipAttempt(write, async () => ({ status: "written", mutationId,
      relationshipVersion: 4, replayed: false, destinations: [{ sourceId: "project-alpha:primary", state: "acknowledged" }] }),
    { mutationId, relationshipVersion: 3 })).rejects.toThrow("could not be verified");
    await expect(executeProfileAttempt(write, async () => ({ ...profileResult, status: "written" }),
      { recordId: mutationId, kind: "client", version: 1 })).rejects.toThrow("could not be verified");
    await expect(executeProfileAttempt(write, async () => ({ ...profileResult,
      destinations: [{ sourceId: "project-alpha:other", state: "pending" }] }),
    { recordId: mutationId, kind: "client", version: 1, sourceIds: ["project-alpha:primary"] }))
      .rejects.toThrow("could not be verified");
    await expect(executeRelationshipAttempt(write, async () => ({ status: "pending", mutationId,
      relationshipVersion: 3, replayed: false, destinations: [
        { sourceId: "project-alpha:primary", state: "pending" },
        { sourceId: "project-alpha:primary", state: "acknowledged" },
      ] }), { mutationId, relationshipVersion: 3 })).rejects.toThrow("could not be verified");
  });
});
