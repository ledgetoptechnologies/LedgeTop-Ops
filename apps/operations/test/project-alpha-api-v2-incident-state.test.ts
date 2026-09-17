import { describe, expect, it } from "vitest";
import { advanceProjectAlphaApiV2Alert, observeProjectAlphaApiV2Incident,
  parseProjectAlphaApiV2IncidentState as parse } from "../src/worker/project-alpha-api-v2-incident-policy";

const identity = { sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://alpha.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const incident = () => observeProjectAlphaApiV2Incident(null, identity,
  { kind: "probe", startedAt: 0, probe: { status: "unavailable", reason: "timeout" } });

describe("persisted API-v2 incident validation", () => {
  it("reclaims a crashed pre-attempt claim without inventing an attempted send", () => {
    const claimed = advanceProjectAlphaApiV2Alert(incident(), { action: "claim", at: 600001, incidentSequence: 1 });
    const reclaimed = advanceProjectAlphaApiV2Alert(claimed,
      { action: "reclaim", at: 900001, incidentSequence: 1, claimSequence: 1 });
    expect(parse(reclaimed)).toMatchObject({ alertClaimSequence: 2, alertClaimedAt: 900001,
      alertAttemptedAt: null, alertSentAt: null });
    expect(advanceProjectAlphaApiV2Alert(reclaimed,
      { action: "attempt", at: 900002, incidentSequence: 1, claimSequence: 1 })).toBe(reclaimed);
  });

  it("round-trips every alert transition and verified recovery", () => {
    let state = incident();
    expect(parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    state = advanceProjectAlphaApiV2Alert(state, { action: "claim", at: 600001, incidentSequence: 1 });
    expect(parse(state)).toEqual(state);
    state = advanceProjectAlphaApiV2Alert(state, { action: "attempt", at: 600001, incidentSequence: 1, claimSequence: 1 });
    expect(parse(state)).toEqual(state);
    state = advanceProjectAlphaApiV2Alert(state, { action: "failed", at: 600002, incidentSequence: 1, claimSequence: 1 });
    expect(parse(state)).toEqual(state);
    state = advanceProjectAlphaApiV2Alert(state, { action: "claim", at: 600003, incidentSequence: 1 });
    expect(parse(state)).toEqual(state);
    state = advanceProjectAlphaApiV2Alert(state, { action: "attempt", at: 600003, incidentSequence: 1, claimSequence: 2 });
    state = advanceProjectAlphaApiV2Alert(state, { action: "sent", at: 600003, incidentSequence: 1, claimSequence: 2 });
    expect(parse(state)).toEqual(state);
    state = observeProjectAlphaApiV2Incident(state, identity, { kind: "probe", startedAt: 700000,
      probe: { status: "verified", sourceInstanceId: identity.expectedSourceInstanceId,
        applicationId: identity.applicationId, historyEpoch: identity.expectedHistoryEpoch,
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", grantedCapabilities: [] } });
    expect(parse(state)).toEqual(state);
    expect(Object.isFrozen(parse(state).identity)).toBe(true);
  });

  it.each([
    { lastProbeStartedAt: NaN }, { incidentSequence: -1 }, { unhealthySince: 1 },
    { reason: "secret-from-remote-error" }, { category: "unknown" },
    { lastVerifiedAt: 0 }, { alertSentAt: 700000 }, { unavailableSince: null },
    { apiKey: "must-not-be-persisted" }, { alertClaimSequence: 1 },
  ])("rejects malformed state %j", patch => {
    expect(() => parse({ ...incident(), ...patch })).toThrow("project_alpha_api_v2_incident_denied");
  });

  it("rejects accessor and extra identity fields without reading them", () => {
    let reads = 0;
    const state = { ...incident() };
    Object.defineProperty(state, "reason", { enumerable: true, get() { reads++; return "timeout"; } });
    expect(() => parse(state)).toThrow();
    expect(reads).toBe(0);
    expect(() => parse({ ...incident(), identity: { ...identity, apiKey: "forbidden" } })).toThrow();
  });
});
