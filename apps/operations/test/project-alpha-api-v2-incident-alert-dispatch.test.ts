import { describe, expect, it, vi } from "vitest";
import { dispatchProjectAlphaApiV2IncidentAlert,
  type ProjectAlphaApiV2AlertDispatchDependencies,
  type ProjectAlphaApiV2AlertDispatchInput } from "../src/worker/project-alpha-api-v2-incident-alert-dispatch";
import { ProjectAlphaApiV2IncidentAlertConflict } from "../src/worker/project-alpha-api-v2-incident-alert-store";
import type { ProjectAlphaApiV2IncidentAlertResult } from "../src/worker/project-alpha-api-v2-incident-alert-store";
import { NotificationMailDeliveryUncertain, type OutboundMail } from "../src/worker/mailer";
import { advanceProjectAlphaApiV2Alert, observeProjectAlphaApiV2Incident,
  type ProjectAlphaApiV2IncidentIdentity,
  type ProjectAlphaApiV2IncidentState } from "../src/worker/project-alpha-api-v2-incident-policy";

const identity: ProjectAlphaApiV2IncidentIdentity = Object.freeze({
  sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://alpha.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const connections = JSON.stringify({ version: 1, connections: [{ ...identity, apiKey: "do-not-send-this-key" }] });
const initial = () => observeProjectAlphaApiV2Incident(null,identity,
  { kind: "probe", startedAt: 0, probe: { status: "unavailable", reason: "transport" } });

function fixture() {
  let state: ProjectAlphaApiV2IncidentState = initial(), revision = 1;
  let enabled = "true", currentConnections = connections, monitorActive = true;
  let now = 600_001;
  const send = vi.fn(async (_mail: OutboundMail) => {});
  const transportReady = vi.fn(async () => {});
  const baseRead = async (_identity: ProjectAlphaApiV2IncidentIdentity) => Object.freeze({ revision, state });
  const read = vi.fn(baseRead);
  const baseTransition = async (action: Parameters<ProjectAlphaApiV2AlertDispatchDependencies["transition"]>[0]):
    Promise<ProjectAlphaApiV2IncidentAlertResult> => {
    if (action.expectedRevision !== revision) throw new ProjectAlphaApiV2IncidentAlertConflict();
    if (action.action === "claim") {
      if (state.alertClaimedAt !== null || state.alertSentAt !== null) return {
        status: "not_due", headRevision: revision, state,
        incidentSequence: state.incidentSequence, claimSequence: state.alertClaimSequence };
      state = advanceProjectAlphaApiV2Alert(state,
        { action: "claim", at: action.at, incidentSequence: state.incidentSequence });
      revision++;
      return { status: "claimed", headRevision: revision, state,
        incidentSequence: state.incidentSequence, claimSequence: state.alertClaimSequence,
        leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
    }
    if (action.incidentSequence !== state.incidentSequence || action.claimSequence !== state.alertClaimSequence
      || action.leaseToken !== "dddddddd-dddd-4ddd-8ddd-dddddddddddd") throw Error("bad_claim");
    state = advanceProjectAlphaApiV2Alert(state,
      { action: action.action, at: action.at, incidentSequence: state.incidentSequence,
        claimSequence: state.alertClaimSequence });
    revision++;
    return { status: action.action === "attempt" ? "attempted" : action.action === "failed" ? "retry" : "sent",
      headRevision: revision, state, incidentSequence: state.incidentSequence,
      claimSequence: state.alertClaimSequence };
  };
  const transition = vi.fn(baseTransition);
  const active = vi.fn(async (_identity: ProjectAlphaApiV2IncidentIdentity, _revision: number) => monitorActive);
  const input: ProjectAlphaApiV2AlertDispatchInput = { identity, monitorRevision: 1, recipient: "owner@example.test",
    currentConfiguration: () => ({ enabled, connections: currentConnections }), clock: () => now };
  const dependencies: ProjectAlphaApiV2AlertDispatchDependencies = { active, read, transition, send, transportReady };
  return { input, dependencies, active, read, transition, send, transportReady, baseRead, baseTransition,
    state: () => state, revision: () => revision,
    observe: (event: Parameters<typeof observeProjectAlphaApiV2Incident>[2]) => {
      state = observeProjectAlphaApiV2Incident(state,identity,event); revision++;
    },
    setEnabled: (value: string) => { enabled = value; },
    setMonitorActive: (value: boolean) => { monitorActive = value; },
    setConnections: (value: string) => { currentConnections = value; },
    setNow: (value: number) => { now = value; } };
}

describe("isolated Project Alpha API v2 incident mail dispatcher", () => {
  it("claims, records an attempt, sends a secret-free owner alert, then records sent", async () => {
    const test = fixture();
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies)).toEqual({ status: "sent" });
    expect(vi.mocked(test.transition).mock.calls.map(([action]) => action.action))
      .toEqual(["claim", "attempt", "sent"]);
    expect(vi.mocked(test.transition).mock.calls.slice(0,2).map(([action]) => action.monitorRevision))
      .toEqual([1,1]);
    expect(vi.mocked(test.transition).mock.calls[2]![0].monitorRevision).toBeUndefined();
    expect(test.send).toHaveBeenCalledTimes(1);
    const mail = test.send.mock.calls[0]![0];
    expect(mail.to).toBe("owner@example.test");
    expect(mail.messageIdKey).toMatch(/^pa-v2-incident-[0-9a-f]{64}$/);
    expect(JSON.stringify(mail)).not.toContain("do-not-send-this-key");
    expect(mail.text).toContain("unavailable");
    expect(test.state().alertSentAt).toBe(600_001);
  });

  it("does not claim when recipient, feature gate, or complete connection identity is absent", async () => {
    const noRecipient = fixture();
    expect(await dispatchProjectAlphaApiV2IncidentAlert({ ...noRecipient.input, recipient: undefined },noRecipient.dependencies))
      .toEqual({ status: "recipient_unavailable" });
    expect(noRecipient.read).not.toHaveBeenCalled();
    const disabled = fixture(); disabled.setEnabled("false");
    expect(await dispatchProjectAlphaApiV2IncidentAlert(disabled.input,disabled.dependencies))
      .toEqual({ status: "disabled" });
    expect(disabled.read).not.toHaveBeenCalled();
    const wrong = fixture(); wrong.setConnections(JSON.stringify({ version: 1, connections: [] }));
    expect(await dispatchProjectAlphaApiV2IncidentAlert(wrong.input,wrong.dependencies))
      .toEqual({ status: "configuration_unavailable" });
    expect(wrong.send).not.toHaveBeenCalled();
  });

  it("reports a missing mail transport before it can claim or schedule a retry", async () => {
    const test = fixture();
    test.transportReady.mockRejectedValueOnce(new Error("SMTP password missing"));
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input, test.dependencies))
      .toEqual({ status: "transport_unavailable" });
    expect(test.read).not.toHaveBeenCalled();
    expect(test.transition).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
  });

  it("requires an active pinned lifecycle before claiming or attempting", async () => {
    const absent = fixture(); absent.setMonitorActive(false);
    expect(await dispatchProjectAlphaApiV2IncidentAlert(absent.input,absent.dependencies))
      .toEqual({ status: "suppressed" });
    expect(absent.transition).not.toHaveBeenCalled();
    const disabledBeforeAttempt = fixture();
    const original = disabledBeforeAttempt.baseTransition;
    disabledBeforeAttempt.transition.mockImplementationOnce(async action => {
      const result = await original(action);
      disabledBeforeAttempt.setMonitorActive(false);
      return result;
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(disabledBeforeAttempt.input,
      disabledBeforeAttempt.dependencies)).toEqual({ status: "suppressed" });
    expect(disabledBeforeAttempt.transition.mock.calls.map(([action]) => action.action)).toEqual(["claim"]);
    expect(disabledBeforeAttempt.send).not.toHaveBeenCalled();
  });

  it("suppresses a claimed alert if configuration is disabled before mail", async () => {
    const test = fixture();
    vi.mocked(test.transition).mockImplementationOnce(async action => {
      const result = await test.baseTransition(action);
      test.setEnabled("false");
      return result;
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies)).toEqual({ status: "suppressed" });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("suppresses delivery when a verified recovery arrives after attempt", async () => {
    const test = fixture();
    let reads = 0;
    vi.mocked(test.read).mockImplementation(async identity => {
      reads++;
      if (reads === 3) test.observe({ kind: "probe", startedAt: 600_002,
        probe: { status: "verified", sourceInstanceId: identity.expectedSourceInstanceId,
          applicationId: identity.applicationId, historyEpoch: identity.expectedHistoryEpoch,
          requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", grantedCapabilities: [] } });
      return test.baseRead(identity);
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies)).toEqual({ status: "suppressed" });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("records a retryable mail failure and does not report sent", async () => {
    const test = fixture();
    test.send.mockRejectedValueOnce(Error("provider unavailable: secret-provider-detail"));
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "mail_failed_retryable" });
    expect(test.state().alertSentAt).toBeNull();
    expect(test.state().alertClaimedAt).toBeNull();
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it("retains an attempted lease when provider acceptance is uncertain", async () => {
    const test = fixture();
    test.send.mockRejectedValueOnce(new NotificationMailDeliveryUncertain());
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "reconciliation_required" });
    expect(test.state()).toMatchObject({ alertClaimSequence: 1, alertAttemptedAt: 600_001,
      alertSentAt: null });
    expect(test.state().alertClaimedAt).not.toBeNull();
    expect(test.transition.mock.calls.map(([action]) => action.action)).toEqual(["claim", "attempt"]);
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it("surfaces a previously attempted lease that needs reconciliation without sending", async () => {
    const test = fixture();
    test.transition.mockImplementationOnce(async () => ({ status: "reconciliation_required",
      headRevision: test.revision(), state: test.state(), incidentSequence: 1, claimSequence: 1 }));
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "reconciliation_required" });
    expect(test.transition.mock.calls.map(([action]) => action.action)).toEqual(["claim"]);
    expect(test.send).not.toHaveBeenCalled();
  });

  it("retries only SENT acknowledgement when a concurrent unhealthy probe advances the head", async () => {
    const test = fixture();
    let once = false;
    vi.mocked(test.transition).mockImplementation(async action => {
      if (action.action === "sent" && !once) {
        once = true;
        test.observe({ kind: "probe", startedAt: 600_002,
          probe: { status: "unauthorized", reason: "credentials_or_scope" } });
        throw new ProjectAlphaApiV2IncidentAlertConflict();
      }
      return test.baseTransition(action);
    });
    test.setNow(600_003);
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies)).toEqual({ status: "sent" });
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(test.transition).mock.calls.filter(([action]) => action.action === "sent")).toHaveLength(2);
    expect(test.state().alertSentAt).toBe(600_003);
  });

  it("does not re-send when mail was accepted but durable acknowledgement cannot be proven", async () => {
    const test = fixture();
    vi.mocked(test.transition).mockImplementation(async action => {
      if (action.action === "sent") throw new ProjectAlphaApiV2IncidentAlertConflict();
      return test.baseTransition(action);
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "accepted_ack_unknown" });
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.state().alertSentAt).toBeNull();
  });

  it("acknowledges an accepted slow mail after lease expiry when the exact claim remains current", async () => {
    const test = fixture();
    test.send.mockImplementationOnce(async () => { test.setNow(660_002); });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies)).toEqual({ status: "sent" });
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.state().alertSentAt).toBe(660_002);
  });

  it("never starts mail when the lease expires during pre-send preparation", async () => {
    const test = fixture();
    let reads = 0;
    test.read.mockImplementation(async selected => {
      reads++;
      if (reads === 4) test.setNow(660_001);
      return test.baseRead(selected);
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "suppressed" });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("rechecks the lease after the final asynchronous active-monitor read", async () => {
    const test = fixture();
    let checks = 0;
    test.active.mockImplementation(async () => {
      checks++;
      if (checks === 6) test.setNow(660_001);
      return true;
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "suppressed" });
    expect(checks).toBe(6);
    expect(test.send).not.toHaveBeenCalled();
  });

  it("rechecks the complete connection after the final asynchronous read", async () => {
    const test = fixture();
    let reads = 0;
    test.read.mockImplementation(async selected => {
      reads++;
      if (reads === 4) test.setConnections(JSON.stringify({ version: 1, connections: [] }));
      return test.baseRead(selected);
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "suppressed" });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("classifies a preparation read failure as storage error, not mail failure", async () => {
    const test = fixture();
    let reads = 0;
    test.read.mockImplementation(async selected => {
      reads++;
      if (reads === 3) throw Error("private database detail");
      return test.baseRead(selected);
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies))
      .toEqual({ status: "storage_error" });
    expect(test.send).not.toHaveBeenCalled();
    expect(test.transition.mock.calls.map(([action]) => action.action)).toEqual(["claim", "attempt"]);
  });

  it("recognizes a committed SENT despite a lost acknowledgement without a second mail", async () => {
    const test = fixture();
    test.transition.mockImplementation(async action => {
      const result = await test.baseTransition(action);
      if (action.action === "sent") throw new ProjectAlphaApiV2IncidentAlertConflict();
      return result;
    });
    expect(await dispatchProjectAlphaApiV2IncidentAlert(test.input,test.dependencies)).toEqual({ status: "sent" });
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.transition.mock.calls.filter(([action]) => action.action === "sent")).toHaveLength(1);
  });
});
