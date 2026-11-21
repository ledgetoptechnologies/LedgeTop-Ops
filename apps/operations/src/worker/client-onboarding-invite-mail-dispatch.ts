import { inviteDestinationsStillBound, parseInviteDestinationIntent } from "./client-onboarding-invite-destinations";
import { mailIssuanceSchemaFence } from "./client-onboarding-target-schema";
import { openInviteMail, resolveInviteMailKeys, snapshotInviteMailKeyring, type InviteMailEnvelope, type InviteMailKeyring } from "./client-onboarding-invite-mail-crypto";

/** This module is not mounted by a scheduler or connected to any provider. */
export type InviteMailOutcome = "sent" | "failed" | "unknown" | "suppressed" | "not_ready";
type Payload = Readonly<{ recipient: string; invitationId: string; invitationSecret: string; expiresAt: string }>;
type Options = Readonly<{ mailKeyring: InviteMailKeyring; destinationBindingsJson: string;
  send: (payload: Payload) => Promise<"accepted" | "rejected" | "unknown"> }>;
type Row = { command_id:string; invitation_id:string; request_sha256:string; recipient_fingerprint_key_id:string;
  recipient_fingerprint:string; key_id:string; nonce_hex:string; ciphertext_hex:string; aad_sha256:string;
  expires_at:string; state:string; version:number; lease_token:string|null; lease_until:string|null;
  attempt_id:string|null; attempted_at:string|null; attempt_fresh:number;
  scopes_json:string|null; destination_intent_json:string|null; target_intent_json:string|null;
  secret_sha256:string; actor_staff_id:string; actor_access_subject:string; invitation_state:string;
  target_client_record_id:string|null; live:number };
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const status=(s:string):InviteMailOutcome=>s==="sent"?"sent":s==="failed"?"failed":s==="suppressed"?"suppressed"
  :s==="attempted"||s==="unknown"?"unknown":"not_ready";
function destinationAllowed(row:Row, config:string): boolean {
  try {
    if (row.invitation_state!=="pending" || row.target_client_record_id!==null || row.target_intent_json!==null
      || row.live!==1 || !row.scopes_json || !row.destination_intent_json) return false;
    const scopes:unknown=JSON.parse(row.scopes_json), stored:unknown=JSON.parse(row.destination_intent_json);
    if (!Array.isArray(scopes)) return false;
    const intent=parseInviteDestinationIntent(stored,scopes);
    if (!intent) return false;
    const authorized={scopes:intent.map(binding=>({businessAreaId:binding.businessAreaId,name:"",allowAreaWide:false,
      divisions:[{divisionId:binding.divisionId,name:""}]}))};
    return inviteDestinationsStillBound(config,authorized,intent);
  } catch { return false; }
}
async function read(db:D1DatabaseSession, commandId:string):Promise<Row|null> {
  return await db.prepare(`SELECT mail.*,command.scopes_json,command.destination_intent_json,command.target_intent_json,
    handoff.secret_sha256,handoff.actor_staff_id,handoff.actor_access_subject,
    invitation.state invitation_state,invitation.target_client_record_id,
    EXISTS(SELECT 1 FROM client_onboarding_live_issuances live WHERE live.invitation_id=invitation.invitation_id) live,
    (mail.attempted_at<=${now} AND mail.attempted_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')) attempt_fresh
    FROM client_onboarding_invite_mail_outbox mail
    JOIN client_onboarding_issuance_commands command ON command.command_id=mail.command_id
      AND command.invitation_id=mail.invitation_id AND command.request_sha256=mail.request_sha256
    JOIN client_onboarding_invitations invitation ON invitation.invitation_id=mail.invitation_id AND invitation.expires_at=mail.expires_at
    JOIN client_onboarding_handoffs handoff ON handoff.command_id=mail.command_id AND handoff.invitation_id=mail.invitation_id
      AND handoff.request_sha256=mail.request_sha256 AND handoff.actor_staff_id=invitation.issued_by
      AND handoff.actor_access_subject=invitation.bound_access_subject
    WHERE mail.command_id=?`).bind(commandId).first<Row>();
}
async function fenced(db:D1DatabaseSession, statement:D1PreparedStatement):Promise<number> {
  const guard=await mailIssuanceSchemaFence(db);const result=await db.batch([guard,statement]);
  const changes=result[1]?.meta.changes;if (!Number.isInteger(changes)||![0,1].includes(Number(changes))) throw Error();
  return Number(changes);
}
/** One claimant crosses the transport boundary at most once; all errors are redacted. */
export async function dispatchInviteMailOnce(database:D1Database, commandId:string, options:Options):Promise<InviteMailOutcome> {
  let attemptBoundaryPossible=false;
  try {
    if (typeof commandId!=="string"||!UUID.test(commandId)||!options||typeof options.destinationBindingsJson!=="string"
      ||options.destinationBindingsJson.length>2048||typeof options.send!=="function") return "not_ready";
    const config=options.destinationBindingsJson, keys=snapshotInviteMailKeyring(options.mailKeyring), send=options.send;
    const db=database.withSession("first-primary");
    let row=await read(db,commandId);if(!row)return "not_ready";
    if(row.state==="claimed"&&row.lease_until&&Date.parse(row.lease_until)<=Date.now()) {
      await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='pending',version=version+1,
        lease_token=NULL,lease_until=NULL WHERE command_id=? AND state='claimed' AND version=? AND lease_token=? AND lease_until<=${now}`)
        .bind(commandId,row.version,row.lease_token));
      row=await read(db,commandId);if(!row)return "not_ready";
    }
    if(row.state!=="pending")return status(row.state);
    if(!destinationAllowed(row,config)) {
      const changed=await fenced(db,db.prepare("UPDATE client_onboarding_invite_mail_outbox SET state='suppressed',version=version+1 WHERE command_id=? AND state='pending' AND version=?")
        .bind(commandId,row.version));return changed===1?"suppressed":status((await read(db,commandId))?.state??"");
    }
    const token=crypto.randomUUID();
    const claimed=await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='claimed',version=version+1,
      lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes')
      WHERE command_id=? AND state='pending' AND version=?`).bind(token,commandId,row.version));
    if(claimed!==1)return "not_ready";
    row=await read(db,commandId);
    if(!row||row.state!=="claimed"||row.lease_token!==token)return "not_ready";
    if(!destinationAllowed(row,config)) {
      const changed=await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='suppressed',version=version+1,lease_token=NULL,lease_until=NULL
        WHERE command_id=? AND state='claimed' AND version=? AND lease_token=?`).bind(commandId,row.version,token));
      return changed===1?"suppressed":status((await read(db,commandId))?.state??"");
    }
    const key=resolveInviteMailKeys(keys,row.key_id,row.recipient_fingerprint_key_id);
    const envelope:InviteMailEnvelope={keyId:row.key_id,fingerprintKeyId:row.recipient_fingerprint_key_id,
      recipientFingerprint:row.recipient_fingerprint,nonceHex:row.nonce_hex,ciphertextHex:row.ciphertext_hex,aadSha256:row.aad_sha256};
    const binding={commandId,invitationId:row.invitation_id,requestSha256:row.request_sha256,secretSha256:row.secret_sha256,
      expiresAt:row.expires_at,staffId:row.actor_staff_id,accessSubject:row.actor_access_subject};
    const clear=await openInviteMail(envelope,binding,key);
    const attemptId=crypto.randomUUID();
    // An ambiguous D1 batch reply may hide a committed attempt marker. Treat it
    // conservatively as unknown even though no transport is called on the error path.
    attemptBoundaryPossible=true;
    const attempted=await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='attempted',version=version+1,
      lease_token=NULL,lease_until=NULL,attempted_at=${now},attempt_id=?
      WHERE command_id=? AND state='claimed' AND version=? AND lease_token=? AND lease_until>${now}
      AND EXISTS(SELECT 1 FROM client_onboarding_issuance_commands command JOIN client_onboarding_live_issuances live
        ON live.invitation_id=command.invitation_id WHERE command.command_id=? AND command.request_sha256=?
        AND command.scopes_json=? AND command.destination_intent_json=? AND command.target_intent_json IS NULL)`)
      .bind(attemptId,commandId,row.version,token,commandId,row.request_sha256,row.scopes_json,row.destination_intent_json));
    if(attempted!==1)return "not_ready";
    // A committed-attempt acknowledgment can arrive after recovery, expiry, or
    // revocation. Re-read on the primary before crossing the transport boundary.
    // first-primary applies to the first query in a session; the earlier
    // session has already been used and must not serve this final read.
    const current=await read(database.withSession("first-primary"),commandId);
    const attemptedAt=current?.attempted_at ? Date.parse(current.attempted_at) : NaN;
    if(!current || current.state!=="attempted" || current.attempt_id!==attemptId || current.version!==row.version+1
      || current.attempt_fresh!==1 || !Number.isFinite(attemptedAt) || attemptedAt>Date.now()
      || Date.now()-attemptedAt>=120_000 || Date.parse(current.expires_at)<=Date.now()
      || current.request_sha256!==row.request_sha256 || current.scopes_json!==row.scopes_json
      || current.destination_intent_json!==row.destination_intent_json || !destinationAllowed(current,config)) {
      if(current?.state==="attempted" && current.attempt_id===attemptId && current.version===row.version+1)
        await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='unknown',version=version+1
          WHERE command_id=? AND state='attempted' AND version=? AND attempt_id=?`).bind(commandId,current.version,attemptId));
      return "unknown";
    }
    let result:"accepted"|"rejected"|"unknown"="unknown";
    try { const value=await send(Object.freeze({recipient:clear.recipient,invitationId:row.invitation_id,invitationSecret:clear.secret,expiresAt:row.expires_at}));
      if(value==="accepted"||value==="rejected")result=value;
    } catch { /* Provider outcome is unknown; never retry. */ }
    const terminal=result==="accepted"?"sent":result==="rejected"?"failed":"unknown";
    const settled=await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state=?,version=version+1
      WHERE command_id=? AND state='attempted' AND version=? AND attempt_id=?`).bind(terminal,commandId,row.version+1,attemptId));
    return settled===1?terminal:"unknown";
  } catch { return attemptBoundaryPossible?"unknown":"not_ready"; }
}
/** A lost attempt is terminal unknown after its bounded settlement window. */
export async function recoverInviteMailAttempt(database:D1Database,commandId:string):Promise<InviteMailOutcome> {
  try {
    if(typeof commandId!=="string"||!UUID.test(commandId))return "not_ready";
    const db=database.withSession("first-primary"), row=await read(db,commandId);if(!row)return "not_ready";
    if(row.state!=="attempted")return status(row.state);
    const changed=await fenced(db,db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='unknown',version=version+1
      WHERE command_id=? AND state='attempted' AND version=? AND attempted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')`)
      .bind(commandId,row.version));
    return changed===1?"unknown":status((await read(db,commandId))?.state??"");
  } catch { return "not_ready"; }
}
