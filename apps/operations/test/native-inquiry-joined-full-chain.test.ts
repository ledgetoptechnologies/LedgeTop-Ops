import { expect, it } from "vitest";
import { runCanonicalPortalResourceAcceptance } from "./helpers/operations-native-portal-resource-acceptance-fixture";
import { ensureOperationsNativeRecipientInquiryCapability } from "../src/worker/operations-portal-native-recipient-inquiry-owner";
import { dispatchOperationsPortalNativeRecipientAuthority, materializeOperationsPortalNativeRecipientAuthority }
  from "../src/worker/operations-portal-native-recipient-authority-dispatch";
import { revokeOperationsPortalNativeRecipient } from "../src/worker/operations-portal-native-recipient-authority";
import { listOpsPrincipalInquiries, submitOpsPrincipalInquiry } from "../src/worker/operations-native-principal-inquiries";
import { applyOperationsPortalNativeInquiryCapability, closeOperationsPortalNativeInquiryCapability,
  readOperationsPortalNativeInquiryCapabilityStatus } from "../../client/src/worker/operations-portal-native-inquiry-capability";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus }
  from "../../client/src/worker/operations-portal-native-recipient-authority";
import { readNativeOperationsRequestCapabilities } from "../../client/src/worker/client-portal/operations-native-request-capability-read";
import { createUnifiedRequestRouter } from "../../client/src/worker/client-portal/unified-request-routes";
import { listStaffInboxInquiries } from "../src/worker/staff-inbox-requests";
import type { Env as ClientEnv } from "../../client/src/worker/types";
import type { StaffPrincipal } from "../src/worker/types";

it("accepts native inquiries through complete current D1 schemas and real consent receipts", async () => {
  await runCanonicalPortalResourceAcceptance(async context => {
    const { operations, client, issuer, subject, workspace, id, owner } = context;
    const intent = await operations.prepare(`SELECT intent_id,grant_operation_id FROM operations_portal_native_recipient_intents
      WHERE recipient_binding_id=?`).bind(context.recipient.recipientBindingId).first<{
        intent_id: string; grant_operation_id: string;
      }>();
    if (!intent?.grant_operation_id || !context.recipient.recipientBindingId)
      throw new Error("canonical consent fixture did not retain its real recipient intent");

    const clientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: "true" };
    const capabilityEnv = { OPS_DB: operations, OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
        applyNativeInquiryCapability: (wire: string) => applyOperationsPortalNativeInquiryCapability(clientEnv, wire),
        closeNativeInquiryCapability: (wire: string) => closeOperationsPortalNativeInquiryCapability(clientEnv, wire),
        getNativeInquiryCapabilityStatus: (wire: string) => readOperationsPortalNativeInquiryCapabilityStatus(clientEnv, wire),
      } };
    await expect(ensureOperationsNativeRecipientInquiryCapability(capabilityEnv, intent.intent_id,
      intent.grant_operation_id, "grant", owner)).resolves.toMatchObject({ ok: true, state: "active" });
    const capability = await readNativeOperationsRequestCapabilities(client, { issuer, subject }, true);
    expect(capability).toHaveLength(1);

    const operationsEnv = { OPS_DB: operations, CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: "true" } as unknown as Parameters<typeof submitOpsPrincipalInquiry>[0];
    let loseFirstAcknowledgement = true;
    const binding = {
      listNativePrincipalInquiries: (wire: string) => listOpsPrincipalInquiries(operationsEnv, wire),
      submitNativePrincipalInquiry: async (wire: string) => {
        const result = await submitOpsPrincipalInquiry(operationsEnv, wire);
        if (loseFirstAcknowledgement && (JSON.parse(result) as { ok?: unknown }).ok === true) {
          loseFirstAcknowledgement = false;
          throw new Error("simulated response loss after Operations committed the inquiry");
        }
        return result;
      },
    };
    const portalOrigin = "https://client-staging.example.test";
    const principal = { issuer, subject, email: "recipient@example.test" };
    const router = createUnifiedRequestRouter({ resolvePrincipal: async () => principal, checkConfiguration: false,
      scopedFetch: async () => new Response("Not used by the inquiry routes", { status: 404 }) });
    const portalEnv = { ...clientEnv, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: "true", CLIENT_PORTAL_ORIGINS: portalOrigin,
      CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: "true",
      OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES: binding } as unknown as ClientEnv;
    const send = (path: string, init?: RequestInit) => router.fetch(new Request(`${portalOrigin}${path}`, {
      ...init, headers: { Origin: portalOrigin, ...(init?.headers as Record<string, string> | undefined) },
    }), portalEnv);
    const idempotencyKey = `joined-inquiry-${id()}`;
    const body = JSON.stringify({ kind: "other", title: "Joined acceptance inquiry",
      details: "Verify the native consent and inquiry chain.", location: null });
    const submit = () => send("/inquiries", { method: "POST", headers: { "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey }, body });

    const lostAcknowledgement = await submit();
    expect(lostAcknowledgement.status).toBe(503);
    expect(await operations.prepare("SELECT count(*) n FROM operations_native_principal_inquiries")
      .first<number>("n")).toBe(1);
    const created = await submit();
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { inquiry: { id: string; title: string; details: string } };
    expect(createdBody.inquiry).toMatchObject({ title: "Joined acceptance inquiry",
      details: "Verify the native consent and inquiry chain." });
    const exactRetry = await submit();
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toEqual(createdBody);
    const changedBody = JSON.stringify({ kind: "other", title: "Changed acceptance inquiry",
      details: "The key is already bound to another request.", location: null });
    const conflict = await send("/inquiries", { method: "POST", headers: { "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey }, body: changedBody });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });

    const history = await send("/inquiries");
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ inquiries: [createdBody.inquiry] });
    expect(await operations.prepare("SELECT count(*) n FROM operations_native_principal_inquiries")
      .first<number>("n")).toBe(1);
    expect(await operations.prepare("SELECT count(*) n FROM operations_native_principal_inquiry_outbox")
      .first<number>("n")).toBe(1);
    expect(await operations.prepare("SELECT count(*) n FROM operations_native_principal_inquiry_audit")
      .first<number>("n")).toBe(1);
    expect(await operations.prepare(`SELECT target_id FROM operations_portal_native_recipient_authority_heads
      WHERE recipient_binding_id=?`).bind(context.recipient.recipientBindingId).first<string>("target_id"))
      .toBe(workspace.targetId);

    const staffEnv = { OPS_DB: operations, DELIVERY_DB: client,
      OPERATIONS_SESSION_SECRET: "joined-native-inquiry-inbox-secret-at-least-32-bytes" } as unknown as Parameters<typeof listStaffInboxInquiries>[0];
    const staff: StaffPrincipal = { id: owner.identity.staffId, email: owner.identity.email,
      displayName: owner.identity.displayName, accessSubject: owner.identity.verifiedAccessSubject,
      projectAlphaUserId: null };
    const inbox = await listStaffInboxInquiries(staffEnv, staff);
    expect(inbox.items).toContainEqual(expect.objectContaining({ id: `ops:${createdBody.inquiry.id}`,
      title: "Joined acceptance inquiry", status: "received" }));

    const foreignRouter = createUnifiedRequestRouter({ resolvePrincipal: async () => ({ issuer,
      subject: "access|foreign-principal", email: "foreign@example.test" }), checkConfiguration: false,
      scopedFetch: async () => new Response("Not used by the inquiry routes", { status: 404 }) });
    const foreign = await foreignRouter.fetch(new Request(`${portalOrigin}/inquiries`, { headers: { Origin: portalOrigin } }), portalEnv);
    expect(foreign.status).toBe(403);
    expect(await operations.prepare("SELECT count(*) n FROM operations_native_principal_inquiries")
      .first<number>("n")).toBe(1);

    const revoked = await revokeOperationsPortalNativeRecipient(operations, { operationId: id(),
      intentId: intent.intent_id, expectedRevision: 4, owner });
    await materializeOperationsPortalNativeRecipientAuthority(operations, revoked.authorityOperationId);
    const recipientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" };
    const recipientBinding = {
      applyNativeAuthority: (wire: string) => applyOperationsPortalNativeRecipientAuthority(recipientEnv, wire),
      getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus(recipientEnv, wire),
    };
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: operations,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: recipientBinding,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true" }, revoked.authorityOperationId))
      .resolves.toMatchObject({ status: "acknowledged" });
    await expect(ensureOperationsNativeRecipientInquiryCapability(capabilityEnv, intent.intent_id,
      revoked.authorityOperationId, "revoke", owner)).resolves.toMatchObject({ ok: true, state: "revoked" });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    const deniedRetry = await submit();
    expect(deniedRetry.status).toBe(403);
    const deniedHistory = await send("/inquiries");
    expect(deniedHistory.status).toBe(403);
    expect(await operations.prepare("SELECT count(*) n FROM operations_native_principal_inquiries")
      .first<number>("n")).toBe(1);
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await operations.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, { stopAfterReady: true, operationsThroughMigration: "0243_staff_logs_device_eligibility.sql",
    clientThroughMigration: "0243_operations_portal_native_inquiry_capability.sql", recipientPermissionSchemaVersion: 4 });
}, 300_000);
