import { parseSharedCompanySelection, prepareClientOnboardingSharedCompanyPlan, readClientOnboardingSharedCompanyChoices } from "./client-onboarding-shared-company-plan";
import { approveClientOnboardingSharedCompany } from "./client-onboarding-shared-company-approval";
import { parseClientOnboardingOrganizationSelection, readClientOnboardingExistingCompanies } from "./client-onboarding-existing-company";
import { readClientOnboardingPortalActivationStatus } from "./client-onboarding-portal-activation";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type AuthenticatedNativeStaff,
  type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { issueClientOnboardingWithHandoff, issueClientOnboardingMailWithHandoff, revealClientOnboardingSecret,
  snapshotClientOnboardingKeyring, type ClientOnboardingKeyring } from "./client-onboarding-handoff";
import { normalizeInviteDeliveryAddress, snapshotInviteMailKeyring } from "./client-onboarding-invite-mail-crypto";
import { readClientOnboardingSubmissionForReview, listClientOnboardingSubmissionsForReview } from "./client-onboarding-review";
import { approveNewNativeOnlyClientOnboarding } from "./client-onboarding-approval";
import { readClientOnboardingEnrollmentChoices } from "./client-onboarding-enrollment-discovery";
import { parseClientOnboardingEnrollmentSourceIds } from "./client-onboarding-enrollment-selection";
import { readClientOnboardingScopeChoices } from "./client-onboarding-scope-choices";
import { allowedInviteDestinationBindings, resolveInviteDestinations } from "./client-onboarding-invite-destinations";
import { admittedOperationsRequestOrigin } from "./host-admission";
import { currentInviteTargetChoice, searchInviteTargets, verifyInviteTargetChoice, type VerifiedInviteTarget } from "./client-onboarding-target-choices";
import { listEnabledProjectAlphaApiV2SourceIds, resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { consumeNativeStaffOnboardingRateLimit } from "./native-staff-onboarding-rate-limit";

export type ClientOnboardingStaffRoute = "session" | "scope-choices" | "target-choices" | "target-search" | "create" | "create-email" | "reveal" | "review" | "approve" | "enrollment-choices" | "inbox" | "activation-status" | "existing-companies" | "shared-company-plan" | "shared-company-choices" | "approve-shared-company";
export type ClientOnboardingStaffHttpDependencies = Readonly<{
  environment: string;
  expectedHost: string;
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  /** Configured Ops aliases remain constrained by the shared finite host policy. */
  operationsOrigins?: string;
  handoffKeyringJson?: string;
  inviteDestinationBindingsJson?: string;
  inviteTargetChoicesEnabled?: string;
  inviteTargetIssuanceEnabled?: string;
  /** Test/review only: the deployed dispatcher does not supply these values. */
  inviteMailIssuanceEnabled?: string;
  inviteMailKeysJson?: string;
  /** Canonical portal origin, supplied by deployment configuration, never browser input. */
  recipientOrigin?: string;
  /** Deployment-owned secret passed only to the credential-free list helper. */
  projectAlphaApiV2Connections?: string;
}>;

const BODY_LIMIT = 16_384;
const BUCKET_SECONDS = 600;
const HEX = /^[0-9a-f]{64}$/;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/;
const encoder = new TextEncoder();
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function clientOnboardingStaffHttpRequest(method: string, path: string): ClientOnboardingStaffRoute | null {
  if (method === "GET" && path === "/api/client-onboarding/staff/session") return "session";
  if (method === "POST" && path === "/api/client-onboarding/staff/scope-choices") return "scope-choices";
  if (method === "POST" && path === "/api/client-onboarding/staff/target-choices") return "target-choices";
  if (method === "POST" && path === "/api/client-onboarding/staff/target-search") return "target-search";
  if(method==="POST"&&path==="/api/client-onboarding/staff/shared-company-plan")return "shared-company-plan";
  if(method==="POST"&&path==="/api/client-onboarding/staff/approve-shared-company")return "approve-shared-company";
  if(method==="POST"&&path==="/api/client-onboarding/staff/shared-company-choices")return "shared-company-choices";
  if (method === "POST" && path === "/api/client-onboarding/staff/existing-companies") return "existing-companies";
  if (method === "POST" && path === "/api/client-onboarding/staff/activation-status") return "activation-status";
  if (method === "POST" && path === "/api/client-onboarding/staff/inbox") return "inbox";
  if (method === "POST" && path === "/api/client-onboarding/staff/create") return "create";
  if (method === "POST" && path === "/api/client-onboarding/staff/create-email") return "create-email";
  if (method === "POST" && path === "/api/client-onboarding/staff/reveal") return "reveal";
  if (method === "POST" && path === "/api/client-onboarding/staff/review") return "review";
  if (method === "POST" && path === "/api/client-onboarding/staff/approve") return "approve";
  if (method === "POST" && path === "/api/client-onboarding/staff/enrollment-choices") return "enrollment-choices";
  return null;
}

export function clientOnboardingRecipientUrl(origin: string | undefined,
  invitationId: string, invitationSecret: string): string | null {
  try {
    const parsed = new URL(origin ?? "");
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password
      || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(invitationId)
      || !HEX.test(invitationSecret)) return null;
    return `${parsed.origin}/onboarding/${invitationId}#${invitationSecret}`;
  } catch { return null; }
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && descriptor?.enumerable === true && "value" in descriptor;
  });
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function snapshot(dependencies: ClientOnboardingStaffHttpDependencies) {
  try {
    const { configuration, database } = dependencies;
    if (configuration.enabled !== true) throw new HttpFailure(404, "not_found");
    if (typeof configuration.issuer !== "string" || typeof configuration.staffAudience !== "string"
      || !AUDIENCE.test(configuration.staffAudience) || typeof configuration.origin !== "string"
      || typeof configuration.csrfSecret !== "string" || !database
      || encoder.encode(configuration.csrfSecret).byteLength < 32
      || encoder.encode(configuration.csrfSecret).byteLength > 512) throw Error();
    const issuer = new URL(configuration.issuer);
    const origin = new URL(configuration.origin);
    if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com")
      || issuer.hostname === ".cloudflareaccess.com" || issuer.origin !== configuration.issuer
      || issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password || issuer.port
      || origin.protocol !== "https:" || origin.origin !== configuration.origin || origin.pathname !== "/"
      || origin.search || origin.hash || origin.username || origin.password || origin.port) throw Error();
    return { access: { enabled: true, issuer: configuration.issuer,
      staffAudience: configuration.staffAudience }, origin: configuration.origin,
      csrfSecret: configuration.csrfSecret, database };
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(503, "client_onboarding_unavailable");
  }
}
function keyring(value: unknown): ClientOnboardingKeyring {
  try {
    if (typeof value !== "string" || encoder.encode(value).byteLength > 4_096) throw Error();
    return snapshotClientOnboardingKeyring(JSON.parse(value) as unknown);
  } catch { throw new HttpFailure(503, "client_onboarding_unavailable"); }
}
async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(message))).toString("hex");
}
function csrfMessage(origin: string, access: NativeStaffAccessConfiguration,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, bucket: number): string {
  return JSON.stringify(["client-onboarding-staff-csrf-v1", access.issuer, access.staffAudience,
    origin, auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.identity.email,
    auth.admissionVersion, bucket]);
}
async function csrfToken(secret: string, origin: string, access: NativeStaffAccessConfiguration,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, bucket: number): Promise<string> {
  return hmac(secret, csrfMessage(origin, access, auth, bucket));
}
function safeEqual(candidate: string, expected: string): boolean {
  return candidate.length === 64 && HEX.test(candidate)
    && timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}
async function requireCsrf(request: Request, secret: string, origin: string,
  access: NativeStaffAccessConfiguration, auth: AuthenticatedNativeStaffWithAdmissionVersion): Promise<void> {
  const candidate = request.headers.get("X-CSRF-Token") ?? "";
  const bucket = Math.floor(Date.now() / 1000 / BUCKET_SECONDS);
  const current = await csrfToken(secret, origin, access, auth, bucket);
  const prior = await csrfToken(secret, origin, access, auth, bucket - 1);
  if (!(Number(safeEqual(candidate, current)) | Number(safeEqual(candidate, prior))))
    throw new HttpFailure(403, "client_onboarding_denied");
}
function unexpired(auth: AuthenticatedNativeStaffWithAdmissionVersion): void {
  if (Date.parse(auth.verifiedUntil) <= Date.now()) throw new HttpFailure(403, "client_onboarding_denied");
}
function handoffAuthentication(auth: AuthenticatedNativeStaffWithAdmissionVersion): AuthenticatedNativeStaff {
  return Object.freeze({ identity: auth.identity, verifiedUntil: auth.verifiedUntil });
}
async function body(request: Request, route: Exclude<ClientOnboardingStaffRoute, "session">): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type");
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
    throw new HttpFailure(400, "invalid_request");
  let value: unknown;
  try { value = await readBoundedJson(request, BODY_LIMIT, "Client onboarding staff"); }
  catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413)
      throw new HttpFailure(413, "request_too_large");
    throw new HttpFailure(400, "invalid_request");
  }
  if (!plain(value)) throw new HttpFailure(400, "invalid_request");
  if (route === "scope-choices") {
    if (!exact(value, [])) throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (route === "target-choices") {
    if (!exact(value, ["sourceId", "kind", "publicId"]) || typeof value.sourceId !== "string"
      || (value.kind !== "client" && value.kind !== "organization") || typeof value.publicId !== "string"
      || !/^[a-f0-9]{32}$/.test(value.publicId)) throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (route === "target-search") {
    if (!exact(value, ["sourceId", "kind", "query", "cursor"])
      || (value.sourceId !== "project-alpha:primary" && value.sourceId !== "project-alpha:secondary")
      || (value.kind !== "client" && value.kind !== "organization") || typeof value.query !== "string"
      || value.query.length > 100 || value.query.trim().length < 3 || /[\x00-\x1f\x7f]/.test(value.query)
      || (value.cursor !== null && (typeof value.cursor !== "string" || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value.cursor))))
      throw new HttpFailure(400, "invalid_request");
    return { ...value, query: value.query.trim() };
  }
  if (route === "inbox") {
    if (!exact(value, ["cursor"])) throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if(route==="shared-company-plan") {
    if(!exact(value,["commandId","submissionId","fieldsSha256","sourceIds","organizationSelection"])
      ||parseSharedCompanySelection(value.organizationSelection)===null
      ||parseClientOnboardingEnrollmentSourceIds(value.sourceIds)===null)throw new HttpFailure(400,"invalid_request");
    return value;
  }
  if(route==="approve-shared-company") {
    if(!exact(value,["planId","submissionId","fieldsSha256"]))throw new HttpFailure(400,"invalid_request");
    return value;
  }
  if(route==="shared-company-choices") {
    if(!exact(value,["submissionId","sourceIds","query","afterGroupId"]))throw new HttpFailure(400,"invalid_request");
    return value;
  }
  if (route === "existing-companies") {
    if (!exact(value,["submissionId","sourceIds","query","afterRecordId"])) throw new HttpFailure(400,"invalid_request");
    return value;
  }
  if (route === "approve") {
    if (!(exact(value, ["submissionId", "fieldsSha256"])
        || exact(value, ["submissionId", "fieldsSha256", "sourceIds"])
        || exact(value,["submissionId","fieldsSha256","sourceIds","organizationSelection"]))
      || typeof value.submissionId !== "string" || typeof value.fieldsSha256 !== "string"
      || (Object.hasOwn(value, "sourceIds") && parseClientOnboardingEnrollmentSourceIds(value.sourceIds) === null)
      || (Object.hasOwn(value,"organizationSelection") && parseClientOnboardingOrganizationSelection(value.organizationSelection)===null))
      throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (route === "review" || route === "activation-status") {
    if (!exact(value, ["submissionId"]) || typeof value.submissionId !== "string")
      throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (route === "reveal") {
    if (!exact(value, ["commandId"]) || typeof value.commandId !== "string")
      throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (route === "enrollment-choices") {
    if (!exact(value, ["submissionId"]) || typeof value.submissionId !== "string")
      throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (route === "create-email") {
    if (!exact(value, ["commandId", "expiresAt", "destinationSourceIds", "recipient", "recipientConfirmed"])
      || typeof value.commandId !== "string" || typeof value.expiresAt !== "string"
      || !Array.isArray(value.destinationSourceIds) || !normalizeInviteDeliveryAddress(value.recipient)
      || value.recipientConfirmed !== true) throw new HttpFailure(400, "invalid_request");
    return value;
  }
  if (exact(value, ["commandId", "expiresAt", "destinationSourceIds"]) && typeof value.commandId === "string"
    && typeof value.expiresAt === "string" && Array.isArray(value.destinationSourceIds)) return value;
  if (exact(value, ["commandId", "expiresAt", "destinationSourceIds", "targetChoices"]) && typeof value.commandId === "string"
    && typeof value.expiresAt === "string" && Array.isArray(value.destinationSourceIds)
    && Array.isArray(value.targetChoices) && value.targetChoices.length >= 1 && value.targetChoices.length <= 2) return value;
  if (!exact(value, ["commandId", "expiresAt", "targetClientRecordId", "scopes"])
    || typeof value.commandId !== "string" || typeof value.expiresAt !== "string"
    || (value.targetClientRecordId !== null && typeof value.targetClientRecordId !== "string")
    || (value.scopes !== null && !Array.isArray(value.scopes))) throw new HttpFailure(400, "invalid_request");
  return value;
}

/** Native-staff-only issuance/reveal. Create returns no bearer; reveal relies on
 * the service's current-authority query and append-only reveal audit. */
export async function handleClientOnboardingStaffHttp(request: Request,
  dependencies: ClientOnboardingStaffHttpDependencies): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = clientOnboardingStaffHttpRequest(request.method, url.pathname);
    if (!route) throw new HttpFailure(404, "not_found");
    if (route === "create-email" && dependencies.inviteMailIssuanceEnabled !== "true") throw new HttpFailure(404, "not_found");
    if (route === "target-choices" && dependencies.inviteTargetChoicesEnabled !== "true") throw new HttpFailure(404, "not_found");
    if (route === "target-search" && (dependencies.inviteTargetChoicesEnabled !== "true"
      || dependencies.inviteTargetIssuanceEnabled !== "true")) throw new HttpFailure(404, "not_found");
    const authority = snapshot(dependencies);
    // Capture deployment configuration before authentication/CSRF awaits so a
    // mutable test or host object cannot change the selected destinations.
    const projectAlphaApiV2Connections = dependencies.projectAlphaApiV2Connections;
    const inviteDestinationBindingsJson = dependencies.inviteDestinationBindingsJson;
    const recipientOrigin = dependencies.recipientOrigin;
    const handoff = route === "create" || route === "create-email" || route === "reveal" ? keyring(dependencies.handoffKeyringJson) : undefined;
    const mailKeys = route === "create-email" ? snapshotInviteMailKeyring(JSON.parse(dependencies.inviteMailKeysJson ?? "null")) : undefined;
    const requestOrigin = admittedOperationsRequestOrigin(request.url, { ENVIRONMENT: dependencies.environment,
      EXPECTED_HOST: dependencies.expectedHost, OPERATIONS_ORIGINS: dependencies.operationsOrigins }, authority.origin);
    if (!requestOrigin || url.origin !== requestOrigin || url.search || url.hash)
      throw new HttpFailure(403, "client_onboarding_denied");
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite !== null && fetchSite !== "same-origin")
      throw new HttpFailure(403, "client_onboarding_denied");
    if (route === "session") {
      if (request.headers.get("X-Native-Staff-Request") !== "1"
        || (origin !== null && origin !== requestOrigin)) throw new HttpFailure(403, "client_onboarding_denied");
    } else if (origin !== requestOrigin) throw new HttpFailure(403, "client_onboarding_denied");
    let auth: AuthenticatedNativeStaffWithAdmissionVersion;
    try { auth = await authenticateNativeStaffWithAdmissionVersion(request, authority.database, authority.access); }
    catch { throw new HttpFailure(403, "client_onboarding_denied"); }
    unexpired(auth);
    if (route === "session") {
      const token = await csrfToken(authority.csrfSecret, requestOrigin, authority.access, auth,
        Math.floor(Date.now() / 1000 / BUCKET_SECONDS));
      unexpired(auth);
      return response(200, { csrfToken: token, verifiedUntil: auth.verifiedUntil });
    }
    await requireCsrf(request, authority.csrfSecret, requestOrigin, authority.access, auth);
    unexpired(auth);
    const input = await body(request, route);
    unexpired(auth);
    if (route === "create-email") {
      const digest = await hmac(authority.csrfSecret, JSON.stringify(["client-onboarding-invite-issuance-quota-v1", auth.identity.staffId]));
      const key = `subject:${Buffer.from(digest, "hex").toString("base64url")}`;
      if (!await consumeNativeStaffOnboardingRateLimit(authority.database, key, 20, 60))
        throw new HttpFailure(429, "client_onboarding_rate_limited");
      unexpired(auth);
    }
    if (route === "target-choices" || route === "target-search") {
      const digest = await hmac(authority.csrfSecret, JSON.stringify(["client-onboarding-target-choice-quota-v1", auth.identity.staffId]));
      const key = `subject:${Buffer.from(digest, "hex").toString("base64url")}`;
      if (!await consumeNativeStaffOnboardingRateLimit(authority.database, key, 20, 60))
        throw new HttpFailure(429, "client_onboarding_rate_limited");
      try {
        const authorized = await readClientOnboardingScopeChoices(authority.database, auth);
        const binding = resolveInviteDestinations(inviteDestinationBindingsJson, authorized, [input.sourceId])?.[0];
        if (!binding) throw Error();
        const source = resolveProjectAlphaApiV2Connection({ PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaApiV2Connections }, binding.sourceId);
        const { expectedSourceInstanceId: instance, expectedApplicationId: application, expectedHistoryEpoch: epoch } = source.connection;
        if (!source.enabled || !epoch) throw Error();
        const context = { origin: requestOrigin, auth, binding, source: { instance, application, epoch } };
        const sign = (message: string) => hmac(authority.csrfSecret, message);
        const kind = input.kind as "client" | "organization";
        if (route === "target-search") {
          const page = await searchInviteTargets(authority.database, { ...context, kind,
            query: input.query as string, cursor: input.cursor as string | null }, sign);
          if (!page) throw Error();
          unexpired(auth);
          return response(200, page);
        }
        const choice = await currentInviteTargetChoice(authority.database, { ...context,
          lookup: { kind, publicId: input.publicId as string } }, sign);
        if (!choice) throw Error();
        unexpired(auth);
        return response(200, { choice: choice.reference });
      } catch { throw new HttpFailure(403, "client_onboarding_denied"); }
    }
    if (route === "scope-choices") {
      try {
        const choices = await readClientOnboardingScopeChoices(authority.database, auth);
        unexpired(auth);
        if (inviteDestinationBindingsJson === undefined) return response(200, choices);
        const destinationSourceIds = allowedInviteDestinationBindings(inviteDestinationBindingsJson, choices).map(binding => binding.sourceId);
        let targetDestinationSourceIds: typeof destinationSourceIds = [];
        if (destinationSourceIds.length > 0 && dependencies.inviteTargetChoicesEnabled === "true"
          && dependencies.inviteTargetIssuanceEnabled === "true") {
          try {
            const configured = listEnabledProjectAlphaApiV2SourceIds({ PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaApiV2Connections });
            targetDestinationSourceIds = destinationSourceIds.filter(sourceId => configured.includes(sourceId));
          } catch {
            // Targeting needs a complete connection identity. Ordinary invitations still use their existing scope checks.
          }
        }
        return response(200, { ...choices, destinationSourceIds,
          ...(targetDestinationSourceIds.length > 0 ? { targetDestinationSourceIds } : {}),
          ...(destinationSourceIds.length > 0 && dependencies.inviteMailIssuanceEnabled === "true"
            ? { inviteMailIssuanceAvailable: true } : {}) });
      } catch (error) {
        if (error instanceof Error && error.message === "client_onboarding_scope_choices_denied")
          throw new HttpFailure(403, "client_onboarding_denied");
        throw new HttpFailure(503, "client_onboarding_unavailable");
      }
    }
    if(route==="shared-company-plan"||route==="shared-company-choices"||route==="approve-shared-company") {
      try {
        const result=route==="approve-shared-company"
          ? await approveClientOnboardingSharedCompany(authority.database,auth,input,projectAlphaApiV2Connections,inviteDestinationBindingsJson)
          : route==="shared-company-plan"
          ? await prepareClientOnboardingSharedCompanyPlan(authority.database,auth,input,projectAlphaApiV2Connections,inviteDestinationBindingsJson)
          : await readClientOnboardingSharedCompanyChoices(authority.database,auth,input);
        unexpired(auth);return response(200,result);
      } catch {throw new HttpFailure(403,"client_onboarding_denied");}
    }
    if(route==="existing-companies") {
      try {const choices=await readClientOnboardingExistingCompanies(authority.database,auth,input);
        unexpired(auth);return response(200,choices);
      } catch {throw new HttpFailure(403,"client_onboarding_denied");}
    }
    if (route === "enrollment-choices") {
      try {
        const choices = await readClientOnboardingEnrollmentChoices(authority.database,
          { PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaApiV2Connections }, auth, input);
        unexpired(auth);
        return response(200, choices);
      } catch (error) {
        if (error instanceof Error && error.message === "client_onboarding_enrollment_discovery_unavailable")
          throw new HttpFailure(503, "client_onboarding_unavailable");
        throw new HttpFailure(403, "client_onboarding_denied");
      }
    }
    if (route === "activation-status") {
      try {
        const status = await readClientOnboardingPortalActivationStatus(authority.database, auth, input.submissionId);
        unexpired(auth);
        return response(200, status);
      } catch { throw new HttpFailure(403, "client_onboarding_denied"); }
    }
    if (route === "inbox") {
      try {
        const inbox = await listClientOnboardingSubmissionsForReview(authority.database, auth, input.cursor);
        unexpired(auth);
        return response(200, inbox);
      } catch { throw new HttpFailure(403, "client_onboarding_denied"); }
    }
    if (route === "review") {
      try {
        const review = await readClientOnboardingSubmissionForReview(authority.database, auth, input.submissionId);
        unexpired(auth);
        const { destinationIntent, ...submission } = review;
        return response(200, destinationIntent ? { ...submission, destinationSourceIds: destinationIntent.bindings.map(binding => binding.sourceId) } : submission);
      } catch { throw new HttpFailure(403, "client_onboarding_denied"); }
    }
    if (route === "approve") {
      try {
        const approved = await approveNewNativeOnlyClientOnboarding(authority.database, auth,
          input.submissionId, input.fieldsSha256, input.sourceIds ?? [], projectAlphaApiV2Connections,input.organizationSelection,inviteDestinationBindingsJson);
        return response(200, { decisionId: approved.decisionId, submissionId: approved.submissionId,
          clientRecordId: approved.clientRecordId, clientRecordVersion: approved.clientRecordVersion,
          ...(approved.organizationRecordId === null ? {} : {
            organizationRecordId: approved.organizationRecordId,
            organizationRecordVersion: approved.organizationRecordVersion,
          }),
          relationshipVersion: approved.relationshipVersion, replayed: approved.replayed });
      } catch { throw new HttpFailure(403, "client_onboarding_denied"); }
    }
    if (route === "create" || route === "create-email") {
      if (Object.hasOwn(input, "targetChoices") && (dependencies.inviteTargetChoicesEnabled !== "true"
        || dependencies.inviteTargetIssuanceEnabled !== "true")) throw new HttpFailure(404, "not_found");
      try {
        let issuanceRequest = input;
        let verifiedTargets: VerifiedInviteTarget[] | undefined;
        if (Object.hasOwn(input, "destinationSourceIds")) {
          if (!inviteDestinationBindingsJson) throw Error();
          const authorized = await readClientOnboardingScopeChoices(authority.database, auth);
          const intent = resolveInviteDestinations(inviteDestinationBindingsJson, authorized, input.destinationSourceIds);
          if (!intent) throw Error();
          unexpired(auth);
          issuanceRequest = { commandId: input.commandId, expiresAt: input.expiresAt, targetClientRecordId: null,
            scopes: intent.map(({ businessAreaId, divisionId }) => ({ businessAreaId, divisionId })), destinationIntent: intent };
          if (Array.isArray(input.targetChoices)) {
            const digest = await hmac(authority.csrfSecret, JSON.stringify(["client-onboarding-target-choice-quota-v1", auth.identity.staffId]));
            if (!await consumeNativeStaffOnboardingRateLimit(authority.database, `subject:${Buffer.from(digest, "hex").toString("base64url")}`, 20, 60))
              throw new HttpFailure(429, "client_onboarding_rate_limited");
            verifiedTargets = [];
            for (const choice of input.targetChoices) {
              if (!plain(choice) || !exact(choice, ["sourceId", "kind", "publicId", "choice"])
                || (choice.kind !== "client" && choice.kind !== "organization") || typeof choice.publicId !== "string"
                || !/^[a-f0-9]{32}$/.test(choice.publicId)) throw Error();
              const binding = intent.find(destination => destination.sourceId === choice.sourceId);
              if (!binding || verifiedTargets.some(target => target.context.binding.sourceId === binding.sourceId)) throw Error();
              const source = resolveProjectAlphaApiV2Connection({ PROJECT_ALPHA_API_V2_CONNECTIONS: projectAlphaApiV2Connections }, binding.sourceId);
              const { expectedSourceInstanceId: instance, expectedApplicationId: application, expectedHistoryEpoch: epoch } = source.connection;
              if (!source.enabled || !epoch) throw Error();
              const context = { origin: requestOrigin, auth, binding, source: { instance, application, epoch },
                lookup: { kind: choice.kind as "client" | "organization", publicId: choice.publicId } };
              const pin = await verifyInviteTargetChoice(authority.database, context, choice.choice, message => hmac(authority.csrfSecret, message));
              if (!pin) throw Error();
              verifiedTargets.push({ context, pin });
            }
          }
        }
        if (route === "create-email") {
          const receipt = await issueClientOnboardingMailWithHandoff(authority.database,
            { authenticatedNativeStaff: handoffAuthentication(auth), request: issuanceRequest }, handoff!, input.recipient, mailKeys!);
          return response(200, { invitationId: receipt.invitationId, expiresAt: receipt.expiresAt,
            requestSha256: receipt.requestSha256, state: receipt.state, mailStatus: receipt.mailStatus });
        }
        const receipt = await issueClientOnboardingWithHandoff(authority.database,
          { authenticatedNativeStaff: handoffAuthentication(auth), request: issuanceRequest }, handoff!, ...(verifiedTargets ? [verifiedTargets] : []));
        return response(200, { invitationId: receipt.invitationId, expiresAt: receipt.expiresAt,
          requestSha256: receipt.requestSha256, state: receipt.state });
      } catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure(403, "client_onboarding_denied"); }
    }
    try {
      const revealed = await revealClientOnboardingSecret(authority.database,
        { authenticatedNativeStaff: handoffAuthentication(auth), commandId: input.commandId }, handoff!);
      return response(200, { commandId: revealed.commandId, invitationId: revealed.invitationId,
        expiresAt: revealed.expiresAt, invitationSecret: revealed.invitationSecret,
        recipientUrl: clientOnboardingRecipientUrl(recipientOrigin, revealed.invitationId, revealed.invitationSecret) });
    } catch { throw new HttpFailure(403, "client_onboarding_denied"); }
  } catch (error) {
    const failure = error instanceof HttpFailure ? error
      : new HttpFailure(503, "client_onboarding_unavailable");
    return response(failure.status, { error: failure.code });
  }
}
