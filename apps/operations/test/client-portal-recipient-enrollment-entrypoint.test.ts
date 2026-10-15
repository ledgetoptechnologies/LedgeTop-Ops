import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const calls = vi.hoisted(() => ({ inspect: vi.fn(), redeem: vi.fn() }));
vi.mock("../src/worker/client-portal-recipient-enrollment-ledger", () => ({ inspectRecipientEnrollmentIntent: calls.inspect, redeemRecipientEnrollmentIntent: calls.redeem }));
import { inspectRecipientEnrollmentRpc, redeemRecipientEnrollmentRpc, type RecipientEnrollmentRpcEnv } from "../src/worker/client-portal-recipient-enrollment-entrypoint";
const intentId = "11111111-1111-4111-8111-111111111111", selectionId = "22222222-2222-4222-8222-222222222222";
const target = { clientRecordId: "ops-client", selectionId }, issuer = "https://team.cloudflareaccess.com";
const inspect = { protocolVersion: 1, intentId, opaqueToken: "a".repeat(64) };
const redeem = { ...inspect, operationId: "33333333-3333-4333-8333-333333333333", acknowledged: true,
  acknowledgedTarget: target, principal: { issuer, subject: "person|one" }, verifiedUntil: "2099-01-01T00:00:00.000Z" };
const environment = (): RecipientEnrollmentRpcEnv => ({ OPS_DB: {} as D1Database, ENVIRONMENT: "staging",
  EXPECTED_HOST: "ops-staging.example.test", TEAM_DOMAIN: issuer, CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED: "true" });
beforeEach(() => {
  calls.inspect.mockReset().mockResolvedValue({ intentId, revision: 1, state: "issued", target: { ...target, displayLabel: "Example" }, expiresAt: redeem.verifiedUntil, principal: null });
  calls.redeem.mockReset().mockResolvedValue({ review: { intentId, revision: 2, state: "pending", principal: redeem.principal } });
});
describe("private staging recipient enrollment bridge", () => {
  it.each(["disabled", "production", "wrong-host"])("does not execute in %s", async mode => {
    const env = environment(); if (mode === "disabled") env.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED = "false";
    if (mode === "production") env.ENVIRONMENT = "production"; if (mode === "wrong-host") env.EXPECTED_HOST = "notstaging.example.test";
    expect(await inspectRecipientEnrollmentRpc(env, inspect)).toMatchObject({ ok: false });
    expect(await redeemRecipientEnrollmentRpc(env, redeem)).toMatchObject({ ok: false });
    expect(calls.inspect).not.toHaveBeenCalled(); expect(calls.redeem).not.toHaveBeenCalled();
  });
  it("sanitizes inspection response and does not redeem it", async () => {
    const response = await inspectRecipientEnrollmentRpc(environment(), inspect);
    expect(response).toEqual({ intentId, revision: 1, state: "issued", target: { ...target, displayLabel: "Example" }, expiresAt: redeem.verifiedUntil });
    expect(calls.redeem).not.toHaveBeenCalled(); expect(JSON.stringify(response)).not.toContain(inspect.opaqueToken);
  });
  it("passes exact target acknowledgement and proof, returning no identity", async () => {
    expect(await redeemRecipientEnrollmentRpc(environment(), redeem)).toEqual({ intentId, revision: 2, state: "pending" });
    expect(calls.redeem).toHaveBeenCalledWith(expect.anything(), { intentId, opaqueToken: inspect.opaqueToken,
      operationId: redeem.operationId, principal: redeem.principal, verifiedUntil: redeem.verifiedUntil, acknowledgedTarget: target });
  });
  it.each([
    { acknowledged: false }, { verifiedUntil: "2000-01-01T00:00:00.000Z" },
    { principal: { ...redeem.principal, issuer: "https://other.cloudflareaccess.com" } },
    { principal: { ...redeem.principal, email: "not-authority@example.test" } },
    { acknowledgedTarget: { ...target, displayLabel: "do not infer" } }, { permissions: ["all"] },
  ])("rejects invalid or broadened input %j", async change => {
    expect(await redeemRecipientEnrollmentRpc(environment(), { ...redeem, ...change })).toMatchObject({ ok: false });
    expect(calls.redeem).not.toHaveBeenCalled();
  });
  it("rejects getters and hides storage details", async () => {
    const getter = Object.defineProperty({}, "intentId", { enumerable: true, get() { throw Error("not executed"); } });
    expect(await inspectRecipientEnrollmentRpc(environment(), getter)).toMatchObject({ ok: false });
    calls.inspect.mockRejectedValueOnce(Error("private data"));
    const response = await inspectRecipientEnrollmentRpc(environment(), inspect);
    expect(response).toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
  });
});
