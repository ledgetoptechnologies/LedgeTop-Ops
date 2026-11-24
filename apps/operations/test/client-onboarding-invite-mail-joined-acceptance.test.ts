import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { consumeClientOnboardingRecipientRoute } from "../../client/src/client/client-onboarding-recipient-route";
import { resolveCloudflareClientPrincipal } from "../../client/src/worker/client-portal/access-identity";
import { createClientPortalRouter } from "../../client/src/worker/client-portal/routes";
import { clientOnboardingRecipientRouter } from "../../client/src/worker/client-onboarding-recipient";
import { handleProjectAlphaPortalProjectionRequest, verifyPortalProjectionAccessAssertion } from "../../client/src/worker/project-alpha-portal";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createClientOnboardingMailOptIn, type ClientOnboardingMailOptIn } from "../src/worker/client-onboarding-mail-opt-in";
import { ClientOnboardingRecipientBridge } from "../src/worker/client-onboarding-recipient-entrypoint";
import { clientOnboardingRecipientUrl } from "../src/worker/client-onboarding-staff-http";
import { processClientOnboardingPortalActivation } from "../src/worker/client-onboarding-portal-activation";
import { PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT } from "../src/worker/project-alpha-directory-command-api-v2";
import { PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT } from "../src/worker/project-alpha-directory-profile-api-v2";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";
import { SharedProfilePortalIngress } from "../src/worker/shared-profile-portal-entrypoint";
import type { Env as ClientEnv } from "../../client/src/worker/types";
import type { Env as OperationsEnv } from "../src/worker/types";
// Uses only the pure ACL seed transformation, not the staging runner.
// @ts-expect-error test-only JavaScript artifact module
import { transformSeed } from "../../../scripts/staging-bootstrap.mjs";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const opsOrigin = "https://ops.ledgetopdroneservices.com"; // Exact admitted origin; never fetched.
const clientOrigin = "https://client.example.test";
const paOrigin = "https://pa-mail-joined.example.test";
const issuer = "https://mail-joined-fixture.cloudflareaccess.com";
const staffAudience = "mail-joined-staff-audience", clientAudience = "mail-joined-client-audience";
const projectionAudience = "mail-joined-projection-audience";
const staffId = "mail-joined-reviewer", staffSubject = "mail-joined-reviewer-subject";
const staffEmail = "mail-joined-reviewer@example.test", recipientEmail = "mail-joined-recipient@example.test";
const recipientSubject = "mail-joined-recipient-subject";
const otherEmail = "mail-joined-other@example.test", otherSubject = "mail-joined-other-subject";
const destination = { sourceId: "project-alpha:primary", businessAreaId: "area:mail-joined", divisionId: "division:mail-joined" };
const remoteIdentity = { sourceInstanceId: "a0000000-0000-4000-8000-000000000001",
  applicationId: "b0000000-0000-4000-8000-000000000002", historyEpoch: "c0000000-0000-4000-8000-000000000003" };
const paConnection = JSON.stringify({ version: 1, instances: { [destination.sourceId]: {
  sourceId: destination.sourceId, enabled: true, baseUrl: paOrigin, apiKey: "mail-joined-test-only-key", ...remoteIdentity,
} } });
const capability = { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" };
const paFences = { requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
const createEndpoint = { method: "POST", path: "/api/v2/directory/clients/commands", requiredCapability: "directory.clients.create", ...paFences };
const bindingEndpoint = { method: "GET", path: "/api/v2/bindings/client/status/{base64urlExternalId}",
  requiredCapability: "directory.clients.binding_status.read", ...paFences };
const projection = { applicationKey: "field_operations_portal", path: "/api/internal/project-alpha/portal-v2",
  keyId: "mail-joined-projection", secret: "mail-joined-projection-hmac-test-only-000" };
const handoff = { activeKeyId: "handoff", keys: { handoff: "ab".repeat(32) } };
const mail = { activeEncryptionKeyId: "mail", activeFingerprintKeyId: "fingerprint",
  encryptionKeys: { mail: "bc".repeat(32) }, fingerprintKeys: { fingerprint: "cd".repeat(32) } };
const fields = { clientType: "consumer", name: "Mail Joined Recipient", email: recipientEmail,
  phone: "920-555-0100", organizationName: "", organizationEmail: "", organizationPhone: "",
  addressLine1: "1 Fixture Lane", addressLine2: "", city: "Fixture Town", state: "WI", postalCode: "54123", country: "US" };
const id = () => crypto.randomUUID();
const expires = (ms: number) => new Date(Date.now() + ms).toISOString();
const portalFlags = { CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
  CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true", CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as const;
type Captured = Parameters<NonNullable<ClientOnboardingMailOptIn["send"]>>[0];
type Link = NonNullable<ReturnType<typeof consumeClientOnboardingRecipientRoute>>;
type StaffReceipt = { invitationId: string; expiresAt: string; mailStatus: string; state: string; requestSha256: string };

async function migrate(db: D1Database, directory: URL, ceiling: string) {
  const files = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= ceiling).sort();
  // Two different, ordered Client filenames share 0199 on this composed tree; apply both.
  const repeated = files.filter((name, index) => files.some((other, j) => j !== index && other.slice(0, 4) === name.slice(0, 4)));
  expect(repeated).toEqual(directory.href.includes("/client/")
    ? ["0199_incoming_upload_pickup_lifecycle.sql", "0199_native_viewer_grants.sql"] : []);
  for (const name of files) {
    const raw = readFileSync(new URL(name, directory), "utf8");
    const sql = name === "0002_seed_acl.sql" && directory.href.includes("/operations/")
      ? transformSeed("operations", raw, { email: "seed-owner@example.test", displayName: "Synthetic Staging Fixture Owner",
        clientStaffId: "staging-mail-joined-client-seed", operationsStaffId: "staging-mail-joined-operations-seed" }) as string : raw;
    const statements = splitD1MigrationStatements(sql);
    if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
  }
}

async function expectResponse<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return (response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(body) : body) as T;
}

// Requests to external authorities terminate at the injected fetch boundary. No fallback to real fetch.
function paResponse(value: object, requestId: string, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
}

describe("#702 capture-only onboarding joined acceptance", () => {
  let runtime: Miniflare | undefined, ops: D1Database, delivery: D1Database;
  let accessKey: CryptoKey, jwks: JWTVerifyGetKey, staffToken: string, csrfToken: string;
  let mailAdapter: ReturnType<typeof createClientOnboardingMailOptIn>, bridge: ClientOnboardingRecipientBridge;
  let operationsEnv: OperationsEnv, clientEnv: ClientEnv;
  const captures: Captured[] = [], unexpectedFetch: string[] = [];
  const paCreates: Array<{ commandId: string; externalId: string; profile: typeof fields; expectedAuthorizationGeneration: string }> = [];
  const root = "f".repeat(32), ownPrincipal = "d".repeat(32);

  async function signAccess(sub: string, email: string, audience: string) {
    return new SignJWT({ type: "app", sub, email }).setProtectedHeader({ alg: "RS256", kid: "mail-joined" })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("15m").sign(accessKey);
  }

  function staff(action: string, body?: object) {
    return mailAdapter.fetch(new Request(`${opsOrigin}/api/client-onboarding/staff/${action}`, {
      method: body === undefined ? "GET" : "POST", headers: { Origin: opsOrigin, "Sec-Fetch-Site": "same-origin",
        "X-Native-Staff-Request": "1", "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": staffToken,
        ...(body === undefined ? {} : { "X-CSRF-Token": csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }

  async function issuedLink(email: string = recipientEmail, expiresAt: string = expires(60 * 60_000)) {
    const commandId = id();
    const issued = await expectResponse<StaffReceipt>(await staff("create-email", { commandId, expiresAt,
      destinationSourceIds: [destination.sourceId], recipient: email, recipientConfirmed: true }), 200);
    expect(issued).toEqual({ invitationId: expect.stringMatching(/^[a-f0-9-]{36}$/), requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt, state: "pending", mailStatus: "queued" });
    const capturedBefore = captures.length;
    expect(await mailAdapter.dispatchCommand(commandId)).toBe("sent");
    expect(await mailAdapter.dispatchCommand(commandId)).toBe("sent");
    expect(captures).toHaveLength(capturedBefore + 1);
    const captured = captures[capturedBefore]!;
    expect(captured).toEqual({ recipient: email, invitationId: issued.invitationId, expiresAt,
      invitationSecret: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await ops.prepare("SELECT state,invitation_id FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(commandId).first()).toEqual({ state: "sent", invitation_id: issued.invitationId });

    // #702 sends structured values; the capture adapter uses the real shared link builder,
    // then the real Client fragment parser. Neither rendering nor delivery of a message is claimed.
    const rawUrl = clientOnboardingRecipientUrl(clientOrigin, captured.invitationId, captured.invitationSecret);
    if (!rawUrl) throw new Error("the captured command could not form a Client link");
    const url = new URL(rawUrl);
    const replaceState = vi.fn<History["replaceState"]>();
    const link = consumeClientOnboardingRecipientRoute(url, { state: null, replaceState });
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", `/onboarding/${issued.invitationId}`);
    if (!link) throw new Error("the Client fragment parser did not recognize the captured link");
    return { ...link, expiresAt };
  }

  function recipient(link: Link, action: "session" | "submit", body: object = {}) {
    return clientOnboardingRecipientRouter.request(`${clientOrigin}/${link.invitationId}/${action}`, { method: "POST",
      headers: { Origin: clientOrigin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.70" },
      body: JSON.stringify({ invitationSecret: link.invitationSecret, ...body }),
    }, { CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", CLIENT_ONBOARDING_RECIPIENT_BRIDGE: bridge,
      PUBLIC_SESSION_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as ClientEnv);
  }

  const portal = createClientPortalRouter({ resolvePrincipal: (request, env) => resolveCloudflareClientPrincipal(request, env, jwks) });
  function portalGet(path: string, token: string) {
    return portal.request(`${clientOrigin}${path}`, { headers: { "Cf-Access-Jwt-Assertion": token } }, clientEnv);
  }

  async function publishWorkspace(workspaceId: string, publicId: string, principalId: string, emailHint: string) {
    const token = await signAccess("synthetic-pa-projection", "mail-joined-pa@example.test", projectionAudience);
    const publish = async (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload), timestamp = new Date().toISOString();
      return handleProjectAlphaPortalProjectionRequest(new Request(`${clientOrigin}${projection.path}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": token,
          "X-Portal-Integration-Timestamp": timestamp, "X-Portal-Integration-Application-Key": projection.applicationKey,
          "X-Portal-Integration-Key-Id": projection.keyId, "X-Portal-Integration-Delivery-Id": String(payload.deliveryId),
          "X-Portal-Integration-Body-SHA256": createHash("sha256").update(body).digest("hex"),
          "X-Portal-Integration-Signature": `sha256=${createHmac("sha256", projection.secret)
            .update(`${timestamp}\nPOST\n${projection.path}\n${projection.keyId}\n${payload.deliveryId}\n${body}`).digest("hex")}` }, body,
      }), clientEnv, (request, env) => verifyPortalProjectionAccessAssertion(request, env, jwks));
    };
    const common = { schemaVersion: 2, applicationKey: projection.applicationKey, occurredAt: new Date().toISOString(),
      sourceGeneration: `${workspaceId}-generation`, sourceSequence: 1, workspaceId, snapshotHash: "b".repeat(64),
      recordCount: 4, pageCount: 1 };
    const workspace = { publicId: workspaceId, rootType: "standalone_client", rootPublicId: publicId,
      displayName: `Workspace ${workspaceId}`, sourceVersion: "root-v1", active: true };
    await expectResponse(await publish({ ...common, kind: "snapshot.page", deliveryId: `${workspaceId}-page`, pageNumber: 1,
      workspace, entities: [{ type: "standalone_client", publicId, parentPublicId: null, displayName: workspace.displayName,
        sourceVersion: "root-v1", active: true, primaryContact: false }],
      principals: [{ publicId: principalId, emailHint, displayName: workspace.displayName, sourceVersion: "principal-v1", active: true }],
      entitlements: ["workspace.view", "directory.read"].map((name, i) => ({ publicId: `${workspaceId}-grant-${i}`,
        principalPublicId: principalId, capability: name, effect: "allow", scopeType: "client", scopePublicId: publicId,
        sourceVersion: "grant-v1", active: true, validFrom: common.occurredAt, expiresAt: null })),
    }), 200);
    await expectResponse(await publish({ ...common, kind: "snapshot.activate", deliveryId: `${workspaceId}-activate` }), 200);
  }

  beforeAll(async () => {
    const access = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = { ...await exportJWK(access.publicKey), alg: "RS256", kid: "mail-joined", use: "sig" };
    accessKey = access.privateKey;
    jwks = createLocalJWKSet({ keys: [publicJwk] });
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? "GET";
      if (method === "GET" && url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
      if (url.origin === paOrigin) {
        const requestId = id(), endpoints = [capability, PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT,
          createEndpoint, bindingEndpoint, PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT];
        if (method === "GET" && url.pathname === "/api/v2/capabilities") return paResponse({ ...remoteIdentity, requestId, apiVersion: "2",
          grantedCapabilities: endpoints.map(endpoint => ({ name: endpoint.requiredCapability })), implementedEndpoints: endpoints }, requestId);
        if (method === "GET" && url.pathname === "/api/v2/directory/inventory") return paResponse({ ...remoteIdentity, requestId,
          authorizationGeneration: "8", resources: [], nextCursor: null }, requestId);
        if (method === "POST" && url.pathname === createEndpoint.path) {
          const command = JSON.parse(String(init?.body)) as (typeof paCreates)[number];
          paCreates.push(command);
          return paResponse({ ...remoteIdentity, requestId, replayed: false, result: {
            resource: { type: "client", id: command.externalId, publicId: root, revision: "1" }, authorizationGeneration: "9",
          } }, requestId, 201);
        }
        const created = paCreates[0];
        if (method === "GET" && created && new Headers(init?.headers).get("X-PA-Include-Client-Portal-Identity") === "1"
          && url.pathname === `/api/v2/bindings/client/status/${Buffer.from(created.externalId).toString("base64url")}`) {
          return paResponse({ ...remoteIdentity, requestId, apiVersion: "2", authorizationGeneration: "9",
            binding: { type: "client", externalId: created.externalId, publicId: root, createdAt: "2026-01-01T00:00:00.000Z" },
            resource: { revision: "1", present: true }, clientPortalIdentity: { state: "eligible", principalPublicId: ownPrincipal,
              associationVersion: "a".repeat(64) },
          }, requestId);
        }
      }
      unexpectedFetch.push(`${method} ${url.origin}${url.pathname}`);
      throw new Error("unexpected external request in capture-only fixture");
    }) satisfies typeof fetch);
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"],
      script: "export default {}", d1Databases: { OPS_DB: id(), DELIVERY_DB: id() } });
    ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await migrate(ops, new URL("../migrations/", import.meta.url), "0248");
    await migrate(delivery, new URL("../../client/migrations/", import.meta.url), "0242");
    await ops.batch([
      ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,'Mail Joined Reviewer',?,'active')")
        .bind(staffId, staffEmail, staffSubject),
      ops.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
        .bind(staffId, staffSubject, staffId),
      ops.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,'Mail Joined Reviewer')").bind(staffId, staffEmail),
      ops.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-owner','global','global')").bind(id(), staffId),
      ops.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'Joined Fixture',1)").bind(destination.businessAreaId),
      ops.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES(?,?,'Joined Fixture',1)")
        .bind(destination.divisionId, destination.businessAreaId),
      ...["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"].map(permission =>
        ops.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
          VALUES(?,?,?,'allow','global',1,?)`).bind(id(), staffId, permission, staffId)),
    ]);
    mailAdapter = createClientOnboardingMailOptIn({ environment: "production", expectedHost: new URL(opsOrigin).hostname,
      database: ops, configuration: { enabled: true, issuer, staffAudience, origin: opsOrigin,
        csrfSecret: "mail-joined-staff-csrf-secret-test-only-000" }, recipientOrigin: clientOrigin,
      handoffKeyringJson: JSON.stringify(handoff), inviteDestinationBindingsJson: JSON.stringify([destination]),
      projectAlphaApiV2Connections: paConnection }, { enabled: "true", keysJson: JSON.stringify(mail),
      send: async payload => { captures.push(payload); return "accepted"; } });
    bridge = Object.assign(Object.create(ClientOnboardingRecipientBridge.prototype), { env: {
      OPS_DB: ops, CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", AUDIT_IP_SECRET: "mail-joined-audit-secret-test-only-000",
    } }) as ClientOnboardingRecipientBridge;
    operationsEnv = { OPS_DB: ops, DELIVERY_DB: delivery, ...portalFlags, CLIENT_ONBOARDING_ADMIN_ENABLED: "true",
      NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true",
      PROJECT_ALPHA_API_V2_CONNECTIONS: paConnection } as OperationsEnv;
    clientEnv = { DELIVERY_DB: delivery, ...portalFlags, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: clientOrigin,
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true", CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: clientAudience,
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: projection.applicationKey, PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: projection.keyId,
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: projection.secret, PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: issuer,
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: projectionAudience,
      SHARED_PROFILE_PORTAL: Object.assign(Object.create(SharedProfilePortalIngress.prototype), { env: operationsEnv }),
    } as ClientEnv;
    await delivery.prepare("UPDATE portal_shared_profile_runtime SET hooks_ready=1 WHERE id=1").run();
    staffToken = await signAccess(staffSubject, staffEmail, staffAudience);
    ({ csrfToken } = await expectResponse<{ csrfToken: string }>(await staff("session"), 200));
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await runtime?.dispose();
    expect(unexpectedFetch).toEqual([]);
  });

  it("joins captured bearer open, exact D1 submission, staff approval, PA handoff and first authorized Client access", async () => {
    const link = await issuedLink();
    expect(await expectResponse(await recipient(link, "session"), 200)).toEqual({ ok: true, protocolVersion: 1,
      invitationId: link.invitationId, state: "pending", expiresAt: link.expiresAt });
    const submissionId = id();
    const submitted = await expectResponse<{ fieldsSha256: string }>(await recipient(link, "submit", { submissionId, fields }), 200);
    expect(submitted).toEqual({ ok: true, protocolVersion: 1, state: "submitted", invitationId: link.invitationId,
      submissionId, fieldsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const row = await ops.prepare("SELECT fields_json,fields_sha256 FROM client_onboarding_submissions WHERE invitation_id=? AND submission_id=?")
      .bind(link.invitationId, submissionId).first<{ fields_json: string; fields_sha256: string }>();
    expect(row?.fields_sha256).toBe(submitted.fieldsSha256);
    expect(JSON.parse(row!.fields_json)).toEqual(fields);
    expect(await expectResponse(await staff("review", { submissionId }), 200)).toMatchObject({
      invitationId: link.invitationId, submissionId, fieldsSha256: submitted.fieldsSha256, fields,
      destinationSourceIds: [destination.sourceId] });
    const approved = await expectResponse<{ decisionId: string; clientRecordId: string }>(await staff("approve", {
      submissionId, fieldsSha256: submitted.fieldsSha256, sourceIds: [destination.sourceId],
    }), 200);
    expect(approved).toMatchObject({ submissionId, decisionId: expect.any(String), clientRecordId: expect.any(String),
      clientRecordVersion: 1, replayed: false });
    const outbox = await ops.prepare(`SELECT decision.invitation_id,decision.submission_id,decision.outcome,intent.source_id,outbox.state,outbox.command_id
      FROM client_onboarding_decisions decision JOIN operations_directory_intents intent ON intent.record_id=decision.client_record_id
      JOIN operations_directory_materializations m ON m.intent_id=intent.intent_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=m.command_id WHERE decision.decision_id=?`)
      .bind(approved.decisionId).first<{ command_id: string }>();
    expect(outbox).toEqual({ invitation_id: link.invitationId, submission_id: submissionId, outcome: "approved",
      source_id: destination.sourceId, state: "pending", command_id: expect.any(String) });
    expect(await processClientOnboardingPortalActivation(operationsEnv)).toEqual({ processed: 1, active: 0 });
    expect(await expectResponse(await staff("activation-status", { submissionId }), 200)).toMatchObject({ activation: {
      clientRecordId: approved.clientRecordId, state: "pending", reason: "awaiting_pa" } });
    expect(await delivery.prepare("SELECT COUNT(*) AS n FROM portal_v2_workspace_memberships").first("n")).toBe(0);
    expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(operationsEnv, destination.sourceId, outbox!.command_id))
      .toMatchObject({ status: "acknowledged" });
    expect(paCreates).toEqual([expect.objectContaining({ commandId: outbox!.command_id, externalId: approved.clientRecordId,
      expectedAuthorizationGeneration: "8", profile: expect.objectContaining({ name: fields.name, email: fields.email }) })]);
    const workspace = "mail-recipient-workspace", otherWorkspace = "mail-other-workspace";
    await publishWorkspace(workspace, root, ownPrincipal, paCreates[0]!.profile.email);
    await publishWorkspace(otherWorkspace, "e".repeat(32), "c".repeat(32), otherEmail);
    expect(await processClientOnboardingPortalActivation(operationsEnv)).toEqual({ processed: 1, active: 1 });
    expect(await expectResponse(await staff("activation-status", { submissionId }), 200)).toMatchObject({ activation: {
      clientRecordId: approved.clientRecordId, state: "active", reason: "active" } });
    expect(await ops.prepare(`SELECT id,recipient_mode,workspace_id,principal_public_id,target_public_id,issuer,subject
      FROM shared_profile_portal_grants WHERE record_id=?`).bind(approved.clientRecordId).first()).toMatchObject({
      recipient_mode: "first_verified_identity", workspace_id: workspace, principal_public_id: ownPrincipal,
      target_public_id: root, issuer: null, subject: null });
    expect(await delivery.prepare("SELECT COUNT(*) AS n FROM portal_v2_workspace_memberships").first("n")).toBe(0);

    const access = await signAccess(recipientSubject, recipientEmail, clientAudience);
    const wrong = await signAccess("mail-joined-wrong-subject", recipientEmail, clientAudience);
    const other = await signAccess(otherSubject, otherEmail, clientAudience);
    const inventory = (token: string) => portalGet("/v2/workspaces", token);
    const context = (workspaceId: string, token: string) => portalGet(`/v2/workspaces/${workspaceId}/context`, token);
    expect(await expectResponse(await portalGet("/session", access), 200)).toMatchObject({ account: { email: recipientEmail },
      capabilities: { viewBilling: false, workspaceHierarchyV2: true } });
    expect((await expectResponse<{ workspaces: Array<{ id: string }> }>(await inventory(access), 200)).workspaces.map(w => w.id))
      .toEqual([workspace]);
    expect(await expectResponse(await context(workspace, access), 200)).toMatchObject({ workspace: {
      id: workspace, sourceId: destination.sourceId, rootPublicId: root, resourceMode: "native" } });
    const profile = await expectResponse(await portalGet(`/v2/workspaces/${workspace}/business-profile`, access), 200);
    expect(profile).toMatchObject({ ok: true, profiles: [{ kind: "client", editable: true }] });
    expect(await ops.prepare("SELECT issuer,subject FROM shared_profile_portal_grants WHERE record_id=?")
      .bind(approved.clientRecordId).first()).toEqual({ issuer, subject: recipientSubject });

    // The same verified email does not replace the already-bound Access subject.
    expect(await expectResponse(await inventory(wrong), 403)).toBe("Client access is not provisioned");
    expect(await expectResponse(await context(workspace, wrong), 403)).toBe("Client access is not provisioned");
    expect((await expectResponse<{ workspaces: Array<{ id: string }> }>(await inventory(other), 200)).workspaces.map(w => w.id))
      .toEqual([otherWorkspace]);
    await expectResponse(await context(otherWorkspace, other), 200);
    await expectResponse(await context(workspace, other), 404);
    await expectResponse(await context(otherWorkspace, access), 404);
  });

  it("rejects a captured bearer on another live invitation before it can submit", async () => {
    const link = await issuedLink(), other = await issuedLink("mail-joined-other@example.test");
    const mismatched = { ...other, invitationSecret: link.invitationSecret };
    await expectResponse(await recipient(other, "session"), 200);
    expect(await expectResponse(await recipient(mismatched, "session"), 404)).toEqual({ error: "Unavailable" });
    expect(await expectResponse(await recipient(mismatched, "submit", { submissionId: id(), fields }), 404)).toEqual({ error: "Unavailable" });
    expect(await ops.prepare("SELECT COUNT(*) AS n FROM client_onboarding_submissions WHERE invitation_id=?")
      .bind(other.invitationId).first("n")).toBe(0);
  });

  it("rejects the previously opened captured bearer after schema-supported revocation", async () => {
    const link = await issuedLink();
    await expectResponse(await recipient(link, "session"), 200);
    // There is no staff revoke/replace route for this invitation family; use the real
    // D1 transition guard, not a substitute HTTP endpoint or a fabricated replacement link.
    const revoked = await ops.prepare("UPDATE client_onboarding_invitations SET state='revoked',version=version+1 WHERE invitation_id=?")
      .bind(link.invitationId).run();
    expect(revoked.meta.changes).toBe(1);
    expect(await expectResponse(await recipient(link, "session"), 404)).toEqual({ error: "Unavailable" });
    expect(await expectResponse(await recipient(link, "submit", { submissionId: id(), fields }), 404)).toEqual({ error: "Unavailable" });
    expect(await ops.prepare("SELECT COUNT(*) AS n FROM client_onboarding_submissions WHERE invitation_id=?")
      .bind(link.invitationId).first("n")).toBe(0);
  });

  it("rejects the captured bearer after its real D1 clock expiry", async () => {
    const link = await issuedLink(recipientEmail, expires(5_000));
    await expectResponse(await recipient(link, "session"), 200);
    await expect.poll(() => ops.prepare("SELECT expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AS elapsed FROM client_onboarding_invitations WHERE invitation_id=?")
      .bind(link.invitationId).first("elapsed"), { timeout: 8_000, interval: 200 }).toBe(1);
    expect(await expectResponse(await recipient(link, "session"), 404)).toEqual({ error: "Unavailable" });
    expect(await expectResponse(await recipient(link, "submit", { submissionId: id(), fields }), 404)).toEqual({ error: "Unavailable" });
    expect(await ops.prepare("SELECT COUNT(*) AS n FROM client_onboarding_submissions WHERE invitation_id=?")
      .bind(link.invitationId).first("n")).toBe(0);
  }, 20_000);
});
