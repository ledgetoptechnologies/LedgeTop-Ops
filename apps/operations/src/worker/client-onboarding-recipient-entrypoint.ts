import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ClientOnboardingRecipientBinding, ClientOnboardingRecipientSessionRequestV1,
  ClientOnboardingRecipientSessionResultV1, ClientOnboardingRecipientStatusRequestV1,
  ClientOnboardingRecipientStatusResultV1, ClientOnboardingRecipientSubmitRequestV1,
  ClientOnboardingRecipientSubmitResultV1,
} from "@ltds/shared";
import type { Env } from "./types";
import { hashClientOnboardingInvitationSecret, submitClientOnboarding } from "./client-onboarding-submissions";
import { consumeClientOnboardingRateLimit } from "./client-onboarding-rate-limit";

const unavailable = Object.freeze({ ok: false as const, protocolVersion: 1 as const, code: "unavailable" as const });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

async function rateKey(invitationId: string, action: "read" | "submit"): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${action}:${invitationId}`)));
  return `client-onboarding:invitation:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function permit(env: Env, invitationId: string, action: "read" | "submit", limit: number): Promise<boolean> {
  if (!env || env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED !== "true" || !UUID.test(invitationId)) return false;
  try { return await consumeClientOnboardingRateLimit(env.OPS_DB, await rateKey(invitationId, action), limit, 60); }
  catch { return false; }
}

async function readState(env: Env, invitationId: string, invitationSecret: string,
  submissionId?: string): Promise<ClientOnboardingRecipientSessionResultV1> {
  try {
    const secretSha256 = await hashClientOnboardingInvitationSecret(invitationId, invitationSecret);
    const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT invitation.state,submission.submission_id
      FROM client_onboarding_invitations invitation
      JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
      LEFT JOIN client_onboarding_submissions submission ON submission.invitation_id=invitation.invitation_id
      WHERE invitation.invitation_id=? AND invitation.secret_sha256=?
        AND ((invitation.state='pending' AND invitation.version=1
          AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (invitation.state='submitted' AND invitation.version=2)) LIMIT 2`)
      .bind(invitationId, secretSha256).first<{ state: string; submission_id: string | null }>();
    if (!row) return unavailable;
    if (row.state === "pending" && !submissionId) return { ok: true, protocolVersion: 1, state: "pending" };
    if (row.state === "submitted" && row.submission_id && (!submissionId || row.submission_id === submissionId)) {
      return { ok: true, protocolVersion: 1, state: "submitted", submissionId: row.submission_id };
    }
  } catch { /* Keep the private boundary indistinguishable on malformed, denied, and storage failures. */ }
  return unavailable;
}

/** Private named entrypoint only. It is not mounted on the Operations fetch route. */
export class ClientOnboardingRecipientBridge extends WorkerEntrypoint<Env> implements ClientOnboardingRecipientBinding {
  async session(request: ClientOnboardingRecipientSessionRequestV1): Promise<ClientOnboardingRecipientSessionResultV1> {
    if (request.protocolVersion !== 1 || !await permit(this.env, request.invitationId, "read", 20)) return unavailable;
    return readState(this.env, request.invitationId, request.invitationSecret);
  }
  async submit(request: ClientOnboardingRecipientSubmitRequestV1): Promise<ClientOnboardingRecipientSubmitResultV1> {
    if (request.protocolVersion !== 1 || !await permit(this.env, request.invitationId, "submit", 8)) return unavailable;
    try {
      const receipt = await submitClientOnboarding(this.env.OPS_DB, request);
      return { ok: true, protocolVersion: 1, state: "submitted", submissionId: receipt.submissionId };
    } catch { return unavailable; }
  }
  async status(request: ClientOnboardingRecipientStatusRequestV1): Promise<ClientOnboardingRecipientStatusResultV1> {
    if (request.protocolVersion !== 1 || !UUID.test(request.submissionId)
      || !await permit(this.env, request.invitationId, "read", 20)) return unavailable;
    return readState(this.env, request.invitationId, request.invitationSecret, request.submissionId);
  }
}
