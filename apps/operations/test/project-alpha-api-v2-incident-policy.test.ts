import { describe, expect, it } from "vitest";
import type { ProjectAlphaApiV2Probe } from "../src/worker/project-alpha-api-v2";
import {
  advanceProjectAlphaApiV2Alert,
  observeProjectAlphaApiV2Incident,
  projectAlphaApiV2AlertEligible,
  type ProjectAlphaApiV2IncidentIdentity,
  type ProjectAlphaApiV2IncidentState,
} from "../src/worker/project-alpha-api-v2-incident-policy";

const identity: ProjectAlphaApiV2IncidentIdentity = {
  sourceId: "project-alpha:primary",
  applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://alpha.example.test",
  expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const unavailable: ProjectAlphaApiV2Probe = { status: "unavailable", reason: "transport" };
const unauthorized: ProjectAlphaApiV2Probe = { status: "unauthorized", reason: "credentials_or_scope", httpStatus: 403 };
const incompatible: ProjectAlphaApiV2Probe = { status: "incompatible", reason: "invalid_contract" };
const verified: ProjectAlphaApiV2Probe = { status: "verified",
  sourceInstanceId: identity.expectedSourceInstanceId, applicationId: identity.applicationId,
  historyEpoch: identity.expectedHistoryEpoch, requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  grantedCapabilities: ["api.capabilities.read"] };

function observe(current: ProjectAlphaApiV2IncidentState | null, startedAt: number,
  probe: ProjectAlphaApiV2Probe = unavailable): ProjectAlphaApiV2IncidentState {
  return observeProjectAlphaApiV2Incident(current, identity, { kind: "probe", startedAt, probe });
}

describe("Project Alpha API-v2 per-instance incident policy", () => {
  it("alerts strictly after ten continuous unhealthy minutes", () => {
    const incident = observe(null, 0);
    expect(incident).toMatchObject({ category: "unavailable", reason: "transport", unhealthySince: 0,
      unavailableSince: 0, incidentSequence: 1 });
    expect(projectAlphaApiV2AlertEligible(incident, 599_999)).toBe(false);
    expect(projectAlphaApiV2AlertEligible(incident, 600_000)).toBe(false);
    expect(projectAlphaApiV2AlertEligible(incident, 600_001)).toBe(true);
    expect(Object.isFrozen(incident)).toBe(true);
    expect(Object.isFrozen(incident.identity)).toBe(true);
  });

  it("keeps one unhealthy incident across transport, authorization, contract and rate failures without calling them transport", () => {
    let state = observe(null, 0);
    state = observe(state, 120_000, unauthorized);
    expect(state).toMatchObject({ category: "unauthorized", reason: "credentials_or_scope",
      unhealthySince: 0, unavailableSince: null, incidentSequence: 1 });
    state = observe(state, 300_000, incompatible);
    expect(state).toMatchObject({ category: "incompatible", unhealthySince: 0, incidentSequence: 1 });
    state = observe(state, 400_000, { status: "rate_limited", reason: "rate_limit" });
    expect(state).toMatchObject({ category: "rate_limited", reason: "rate_limit", unhealthySince: 0 });
    state = observe(state, 500_000, { status: "misconfigured", reason: "configuration" });
    expect(state).toMatchObject({ category: "misconfigured", unhealthySince: 0 });
    expect(projectAlphaApiV2AlertEligible(state, 600_001)).toBe(true);
  });

  it("verified recovery closes the incident and a later outage is new; disabled suppresses an alert", () => {
    const first = observe(null, 0);
    const recovered = observe(first, 700_000, verified);
    expect(recovered).toMatchObject({ category: "verified", lastVerifiedAt: 700_000,
      unhealthySince: null, unavailableSince: null, incidentSequence: 1 });
    expect(projectAlphaApiV2AlertEligible(recovered, 1_500_000)).toBe(false);
    const next = observe(recovered, 800_000);
    expect(next).toMatchObject({ unhealthySince: 800_000, incidentSequence: 2 });
    const disabled = observeProjectAlphaApiV2Incident(next, identity, { kind: "disabled", startedAt: 1_500_002 });
    expect(disabled).toMatchObject({ category: "disabled", unhealthySince: null, alertClaimedAt: null });
    expect(projectAlphaApiV2AlertEligible(disabled, 3_000_000)).toBe(false);
  });

  it("ignores stale probe starts, including late-completing recovery, independently from alert action timestamps", () => {
    const first = observe(null, 0);
    const laterDenial = observe(first, 100_000, unauthorized);
    expect(observe(laterDenial, 50_000, verified)).toBe(laterDenial);
    const claimed = advanceProjectAlphaApiV2Alert(laterDenial,
      { action: "claim", at: 600_001, incidentSequence: laterDenial.incidentSequence });
    expect(claimed.alertClaimedAt).toBe(600_001);
    // A newer-started probe may complete after a claim, but a response that
    // started before the last probe cannot recover the incident.
    expect(observe(claimed, 90_000, verified)).toBe(claimed);
    expect(observe(claimed, 200_000, unavailable).lastProbeStartedAt).toBe(200_000);
  });

  it("isolates pinned origin and actual PA instance as well as source/application/epoch", () => {
    const first = observe(null, 0);
    for (const changed of [
      { ...identity, sourceId: "project-alpha:second" },
      { ...identity, applicationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { ...identity, baseUrl: "https://other.example.test" },
      { ...identity, expectedSourceInstanceId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      { ...identity, expectedHistoryEpoch: "11111111-1111-4111-8111-111111111111" },
    ]) expect(() => observeProjectAlphaApiV2Incident(first, changed,
      { kind: "probe", startedAt: 1, probe: verified })).toThrow("project_alpha_api_v2_incident_denied");
    expect(() => observeProjectAlphaApiV2Incident(null, { ...identity, baseUrl: "http://alpha.example.test" },
      { kind: "probe", startedAt: 0, probe: unavailable })).toThrow("project_alpha_api_v2_incident_denied");
  });

  it("separates claim, attempted delivery and sent; a failed send is retryable without a duplicate incident", () => {
    const incident = observe(null, 0);
    const claim = advanceProjectAlphaApiV2Alert(incident, { action: "claim", at: 600_001, incidentSequence: 1 });
    expect(claim).toMatchObject({ alertClaimedAt: 600_001, alertAttemptedAt: null, alertSentAt: null });
    expect(projectAlphaApiV2AlertEligible(claim, 600_002)).toBe(false);
    const attempt = advanceProjectAlphaApiV2Alert(claim,
      { action: "attempt", at: 600_002, incidentSequence: 1, claimSequence: claim.alertClaimSequence });
    expect(attempt.alertAttemptedAt).toBe(600_002);
    const failed = advanceProjectAlphaApiV2Alert(attempt,
      { action: "failed", at: 600_003, incidentSequence: 1, claimSequence: claim.alertClaimSequence });
    expect(failed).toMatchObject({ alertClaimedAt: null, alertAttemptedAt: 600_002, alertSentAt: null,
      unhealthySince: 0, incidentSequence: 1 });
    expect(projectAlphaApiV2AlertEligible(failed, 600_004)).toBe(true);
    const retried = advanceProjectAlphaApiV2Alert(failed, { action: "claim", at: 600_004, incidentSequence: 1 });
    const reattempted = advanceProjectAlphaApiV2Alert(retried,
      { action: "attempt", at: 600_005, incidentSequence: 1, claimSequence: retried.alertClaimSequence });
    expect(advanceProjectAlphaApiV2Alert(reattempted,
      { action: "sent", at: 600_006, incidentSequence: 1, claimSequence: claim.alertClaimSequence })).toBe(reattempted);
    const sent = advanceProjectAlphaApiV2Alert(reattempted,
      { action: "sent", at: 600_007, incidentSequence: 1, claimSequence: retried.alertClaimSequence });
    expect(sent.alertSentAt).toBe(600_007);
    expect(projectAlphaApiV2AlertEligible(sent, 900_000)).toBe(false);
    expect(advanceProjectAlphaApiV2Alert(sent, { action: "claim", at: 900_001, incidentSequence: 1 })).toBe(sent);
  });

  it("does not deliver a stale claimed alert into a new incident", () => {
    const first = observe(null, 0);
    const claim = advanceProjectAlphaApiV2Alert(first, { action: "claim", at: 600_001, incidentSequence: 1 });
    const recovered = observe(claim, 700_000, verified);
    const next = observe(recovered, 800_000, unauthorized);
    expect(advanceProjectAlphaApiV2Alert(next,
      { action: "attempt", at: 900_000, incidentSequence: 1, claimSequence: claim.alertClaimSequence })).toBe(next);
    expect(next.alertSentAt).toBeNull();
  });

  it("allows claim, attempt and sent in one clock millisecond without accepting duplicates", () => {
    const incident = observe(null, 0);
    const claim = advanceProjectAlphaApiV2Alert(incident,
      { action: "claim", at: 600_001, incidentSequence: 1 });
    const attempt = advanceProjectAlphaApiV2Alert(claim,
      { action: "attempt", at: 600_001, incidentSequence: 1, claimSequence: claim.alertClaimSequence });
    expect(attempt.alertAttemptedAt).toBe(600_001);
    expect(advanceProjectAlphaApiV2Alert(attempt,
      { action: "attempt", at: 600_001, incidentSequence: 1, claimSequence: claim.alertClaimSequence })).toBe(attempt);
    const sent = advanceProjectAlphaApiV2Alert(attempt,
      { action: "sent", at: 600_001, incidentSequence: 1, claimSequence: claim.alertClaimSequence });
    expect(sent.alertSentAt).toBe(600_001);
    expect(advanceProjectAlphaApiV2Alert(sent,
      { action: "sent", at: 600_001, incidentSequence: 1, claimSequence: claim.alertClaimSequence })).toBe(sent);
  });
});
