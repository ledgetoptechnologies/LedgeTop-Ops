import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ClientOnboardingRecipientBinding, ClientOnboardingRecipientPendingV1,
  ClientOnboardingRecipientUnavailableV1, ClientOnboardingRecipientSessionRequestV1,
  ClientOnboardingRecipientSessionResultV1, ClientOnboardingRecipientStatusRequestV1,
  ClientOnboardingRecipientStatusResultV1, ClientOnboardingRecipientSubmitRequestV1,
  ClientOnboardingRecipientSubmitResultV1,
} from "@ltds/shared";
import type { Env } from "./types";
import { hashClientOnboardingInvitationSecret, submitClientOnboarding } from "./client-onboarding-submissions";
import { consumeClientOnboardingRateLimit } from "./client-onboarding-rate-limit";

const unavailable = Object.freeze({ ok: false as const, protocolVersion: 1 as const, code: "unavailable" as const });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
type CurrentState = ClientOnboardingRecipientUnavailableV1 | ClientOnboardingRecipientPendingV1 | Readonly<{
  ok: true; protocolVersion: 1; state: "submitted"; invitationId: string; expiresAt: string;
  submissionId: string; fieldsSha256: string;
}>;

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function enabled(env: Env): boolean {
  const secret = env?.AUDIT_IP_SECRET;
  return env?.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED === "true"
    && typeof secret === "string" && encoder.encode(secret).byteLength >= 32
    && encoder.encode(secret).byteLength <= 512 && Boolean(env.OPS_DB);
}

function exactRecord(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    copy[name] = descriptor.value;
  }
  return copy;
}

async function permit(env: Env, invitationId: string, action: "read" | "submit", limit: number): Promise<boolean> {
  if (!enabled(env) || !UUID.test(invitationId)) return false;
  try {
    const digest = await hmacHex(env.AUDIT_IP_SECRET,
      `client-onboarding-recipient-quota-v1:${action}:${invitationId}`);
    return await consumeClientOnboardingRateLimit(env.OPS_DB,
      `client-onboarding:invitation:${digest}`, limit, 60);
  } catch { return false; }
}

async function readState(env: Env, invitationId: string, invitationSecret: string,
  submissionId?: string): Promise<CurrentState> {
  if (!enabled(env)) return unavailable;
  try {
    const secretSha256 = await hashClientOnboardingInvitationSecret(invitationId, invitationSecret);
    const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT invitation.state,invitation.expires_at,
        submission.submission_id,submission.fields_sha256
      FROM client_onboarding_invitations invitation
      JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
      LEFT JOIN client_onboarding_submissions submission ON submission.invitation_id=invitation.invitation_id
      WHERE invitation.invitation_id=? AND invitation.secret_sha256=?
        AND ((invitation.state='pending' AND invitation.version=1
          AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (invitation.state='submitted' AND invitation.version=2)) LIMIT 2`)
      .bind(invitationId, secretSha256).first<{
        state: string; expires_at: string; submission_id: string | null; fields_sha256: string | null;
      }>();
    if (!row) return unavailable;
    if (row.state === "pending") return { ok: true, protocolVersion: 1, state: "pending",
      invitationId, expiresAt: row.expires_at };
    if (row.state === "submitted" && row.submission_id && row.fields_sha256
      && (!submissionId || row.submission_id === submissionId)) return {
      ok: true, protocolVersion: 1, state: "submitted", invitationId, expiresAt: row.expires_at,
      submissionId: row.submission_id, fieldsSha256: row.fields_sha256,
    };
  } catch { /* Keep the private boundary indistinguishable on malformed, denied, and storage failures. */ }
  return unavailable;
}

/** Private named entrypoint only. It is not mounted on the Operations fetch route. */
export class ClientOnboardingRecipientBridge extends WorkerEntrypoint<Env> implements ClientOnboardingRecipientBinding {
  async session(rawRequest: ClientOnboardingRecipientSessionRequestV1): Promise<ClientOnboardingRecipientSessionResultV1> {
    const request = exactRecord(rawRequest, ["protocolVersion", "invitationId", "invitationSecret"]);
    if (!request || request.protocolVersion !== 1 || typeof request.invitationId !== "string"
      || typeof request.invitationSecret !== "string" || !SECRET.test(request.invitationSecret)) return unavailable;
    const state = await readState(this.env, request.invitationId, request.invitationSecret);
    if (!state.ok || !await permit(this.env, request.invitationId, "read", 20)) return unavailable;
    if (state.state === "pending") return state;
    return { ok: true, protocolVersion: 1, state: "submitted", invitationId: state.invitationId,
      expiresAt: state.expiresAt, submissionId: state.submissionId };
  }
  async submit(rawRequest: ClientOnboardingRecipientSubmitRequestV1): Promise<ClientOnboardingRecipientSubmitResultV1> {
    const request = exactRecord(rawRequest,
      ["protocolVersion", "invitationId", "invitationSecret", "submissionId", "fields"]);
    if (!request || request.protocolVersion !== 1 || typeof request.invitationId !== "string"
      || typeof request.invitationSecret !== "string" || !SECRET.test(request.invitationSecret)
      || typeof request.submissionId !== "string" || !UUID.test(request.submissionId)) return unavailable;
    const state = await readState(this.env, request.invitationId, request.invitationSecret);
    if (!state.ok || (state.state === "submitted" && state.submissionId !== request.submissionId)
      || !await permit(this.env, request.invitationId, "submit", 8)) return unavailable;
    try {
      const receipt = await submitClientOnboarding(this.env.OPS_DB, {
        invitationId: request.invitationId,
        invitationSecret: request.invitationSecret,
        submissionId: request.submissionId,
        fields: request.fields,
      });
      return { ok: true, protocolVersion: 1, state: "submitted", invitationId: receipt.invitationId,
        submissionId: receipt.submissionId, fieldsSha256: receipt.fieldsSha256 };
    } catch { return unavailable; }
  }
  async status(rawRequest: ClientOnboardingRecipientStatusRequestV1): Promise<ClientOnboardingRecipientStatusResultV1> {
    const request = exactRecord(rawRequest,
      ["protocolVersion", "invitationId", "invitationSecret", "submissionId"]);
    if (!request || request.protocolVersion !== 1 || typeof request.invitationId !== "string"
      || typeof request.invitationSecret !== "string" || !SECRET.test(request.invitationSecret)
      || typeof request.submissionId !== "string" || !UUID.test(request.submissionId)) return unavailable;
    const state = await readState(this.env, request.invitationId, request.invitationSecret, request.submissionId);
    if (!state.ok || !await permit(this.env, request.invitationId, "read", 20)) return unavailable;
    if (state.state === "pending") return state;
    return { ok: true, protocolVersion: 1, state: "submitted", invitationId: state.invitationId,
      submissionId: state.submissionId, fieldsSha256: state.fieldsSha256 };
  }
}
