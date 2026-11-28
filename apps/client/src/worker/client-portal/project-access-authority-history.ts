import type { ProjectAccessTermsActor, ProjectAccessTermsScope } from './project-access-terms';

type Database=Pick<D1Database,'prepare'>;
type BatchDatabase=Pick<D1Database,'prepare'|'batch'>;
export type ProjectAccessAuthorityType='invitation_request'|'invitation'|'authenticated_delivery_grant';
export type ProjectAccessAuthorityEventKind='request_submitted'|'invitation_created'|'invitation_approved'|'invitation_accepted'
  |'invitation_revoked'|'grant_created'|'grant_restored'|'grant_revoked'|'access_expired';

const HISTORY_TABLES=['portal_project_access_authority_history_state','portal_project_access_authority_events'] as const;
export async function projectAccessAuthorityHistoryReady(db:Database):Promise<boolean>{
  const rows=(await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?)`)
    .bind(...HISTORY_TABLES).all<{name:string}>()).results;
  if(rows.length===0)return false;
  if(rows.length!==HISTORY_TABLES.length)throw new Error('project access authority history schema is incomplete');
  return true;
}

export function projectAccessAuthorityEvent(db:Database,input:ProjectAccessTermsScope&{
  accessTermsId:string;authorityType:ProjectAccessAuthorityType;authorityId:string;eventKind:ProjectAccessAuthorityEventKind;
  producerEventKey:string;actor:ProjectAccessTermsActor|{type:'system';id:null};subjectIdentityId?:string|null;id?:string;occurredAt?:string;
}):D1PreparedStatement{
  return db.prepare(`INSERT INTO portal_project_access_authority_events
    (id,workspace_id,source_id,project_public_id,access_terms_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,actor_id,subject_identity_id,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ON CONFLICT(producer_event_key) DO NOTHING`)
    .bind(input.id??crypto.randomUUID(),input.workspaceId,input.sourceId,input.projectPublicId,input.accessTermsId,input.authorityType,
      input.authorityId,input.producerEventKey,input.eventKind,input.actor.type,input.actor.id,input.subjectIdentityId??null,input.occurredAt??null);
}

/** Derives coordinates only from an invitation's explicit immutable term FK. */
export function projectAccessInvitationEvent(db:Database,input:{invitationId:string;
  eventKind:Extract<ProjectAccessAuthorityEventKind,'invitation_created'|'invitation_approved'|'invitation_accepted'|'invitation_revoked'|'access_expired'>;
  producerEventKey:string;actor:ProjectAccessTermsActor|{type:'system';id:null};subjectIdentityId?:string|null;id?:string;requiredMembershipAuditId?:string;occurredAt?:string;
}):D1PreparedStatement{
  const provenTerms=input.requiredMembershipAuditId?`CASE WHEN EXISTS(SELECT 1 FROM portal_v2_membership_audit proof
    WHERE proof.id=? AND proof.workspace_id=invitation.workspace_id AND proof.invitation_id=invitation.id
      AND proof.action=CASE ? WHEN 'invitation_created' THEN 'invitation.created'
        WHEN 'invitation_accepted' THEN 'invitation.accepted' ELSE 'invitation.revoked' END)
      THEN terms.id ELSE '__invalid_membership_proof__' END`:'terms.id';
  const requiredFallback=input.requiredMembershipAuditId?`UNION ALL
    SELECT ?,'__missing_workspace__','__missing_source__','__missing_project__','__missing_terms__','invitation',?,?,'__required_proof_missing__',?,?,?,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE NOT EXISTS(SELECT 1 FROM portal_v2_invitations target
      JOIN portal_v2_invitation_entitlements target_entitlement ON target_entitlement.invitation_id=target.id AND target_entitlement.access_terms_id IS NOT NULL
      JOIN portal_project_access_terms target_terms ON target_terms.id=target_entitlement.access_terms_id AND target_terms.workspace_id=target.workspace_id
      WHERE target.id=?)
      AND (NOT EXISTS(SELECT 1 FROM portal_v2_invitations existing WHERE existing.id=?)
        OR EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements term_backed
          WHERE term_backed.invitation_id=? AND term_backed.access_terms_id IS NOT NULL))`:'';
  return db.prepare(`INSERT INTO portal_project_access_authority_events
    (id,workspace_id,source_id,project_public_id,access_terms_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,actor_id,subject_identity_id,occurred_at)
    SELECT ?,terms.workspace_id,terms.source_id,terms.project_public_id,${provenTerms},'invitation',invitation.id,?,?,?,?,?,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    FROM portal_v2_invitations invitation
    JOIN portal_v2_invitation_entitlements entitlement ON entitlement.invitation_id=invitation.id AND entitlement.access_terms_id IS NOT NULL
    LEFT JOIN portal_project_access_terms terms ON terms.id=entitlement.access_terms_id AND terms.workspace_id=invitation.workspace_id
    WHERE invitation.id=?
    GROUP BY terms.id HAVING count(*)>0
    ${requiredFallback}
    ON CONFLICT(producer_event_key) DO NOTHING`)
    .bind(input.id??crypto.randomUUID(),...(input.requiredMembershipAuditId?[input.requiredMembershipAuditId,input.eventKind]:[]),
      input.producerEventKey,input.eventKind,input.actor.type,input.actor.id,input.subjectIdentityId??null,input.occurredAt??null,input.invitationId,
      ...(input.requiredMembershipAuditId?[crypto.randomUUID(),input.invitationId,input.producerEventKey,input.actor.type,input.actor.id,
        input.subjectIdentityId??null,input.occurredAt??null,input.invitationId,input.invitationId,input.invitationId]:[]));
}

/** Derives coordinates from an authenticated grant binding. The history row
 * deliberately omits a subject because one grant may resolve many recipients. */
export function projectAccessGrantEvent(db:Database,input:{grantId:string;
  eventKind:Extract<ProjectAccessAuthorityEventKind,'grant_created'|'grant_restored'|'grant_revoked'|'access_expired'>;
  producerEventKey:string;actor:ProjectAccessTermsActor|{type:'system';id:null};id?:string;requiredGrantAuditId?:string;
  requiredNativeEvent?:{authorizationId:string;action:'published'|'revoked'|'suspended';requirePublished?:boolean};occurredAt?:string;
}):D1PreparedStatement{
  const requiredProofs:string[]=[];const proofValues:unknown[]=[];
  if(input.requiredGrantAuditId){requiredProofs.push(`EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grant_audit proof
    WHERE proof.id=? AND proof.grant_id=grant_record.id AND proof.action=CASE ?
      WHEN 'grant_created' THEN 'grant.created' WHEN 'grant_restored' THEN 'grant.restored' ELSE 'grant.revoked' END)`);
    proofValues.push(input.requiredGrantAuditId,input.eventKind);}
  if(input.requiredNativeEvent){requiredProofs.push(`EXISTS(SELECT 1 FROM portal_native_staff_grant_events native_proof
    WHERE native_proof.grant_id=grant_record.id AND native_proof.authorization_id=? AND native_proof.action=?
      AND ((?='grant_created' AND native_proof.action='published') OR (?='grant_revoked' AND native_proof.action IN('revoked','suspended'))))`);
    proofValues.push(input.requiredNativeEvent.authorizationId,input.requiredNativeEvent.action,input.eventKind,input.eventKind);
    if(input.requiredNativeEvent.requirePublished){requiredProofs.push(`EXISTS(SELECT 1 FROM portal_native_staff_grants publication_proof
      JOIN portal_native_staff_grant_events published_proof ON published_proof.grant_id=publication_proof.grant_id
        AND published_proof.authorization_id=publication_proof.authorization_id AND published_proof.action='published'
      WHERE publication_proof.grant_id=grant_record.id)`);}}
  const provenTerms=requiredProofs.length?`CASE WHEN ${requiredProofs.join(' AND ')} THEN terms.id ELSE '__invalid_grant_proof__' END`:'terms.id';
  const requiredFallback=requiredProofs.length?`UNION ALL
    SELECT ?,'__missing_workspace__','__missing_source__','__missing_project__','__missing_terms__','authenticated_delivery_grant',?,?,'__required_proof_missing__',?,?,NULL,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE NOT EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants target
      JOIN portal_project_access_terms target_terms ON target_terms.id=target.access_terms_id AND target_terms.workspace_id=target.workspace_id
      JOIN portal_v2_folder_bindings target_binding ON target_binding.id=target.folder_binding_id AND target_binding.workspace_id=target.workspace_id
        AND target_binding.owner_scope_type='project' AND target_binding.owner_public_id=target_terms.project_public_id
      WHERE target.id=? AND target.access_terms_id IS NOT NULL)
      AND (NOT EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants existing WHERE existing.id=?)
        OR EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants term_backed WHERE term_backed.id=? AND term_backed.access_terms_id IS NOT NULL))`:'';
  return db.prepare(`INSERT INTO portal_project_access_authority_events
    (id,workspace_id,source_id,project_public_id,access_terms_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,actor_id,subject_identity_id,occurred_at)
    SELECT ?,terms.workspace_id,terms.source_id,terms.project_public_id,${provenTerms},'authenticated_delivery_grant',grant_record.id,?,?,?,?,NULL,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    FROM portal_v2_authenticated_delivery_grants grant_record
    LEFT JOIN portal_project_access_terms terms ON terms.id=grant_record.access_terms_id AND terms.workspace_id=grant_record.workspace_id
    LEFT JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id
      AND binding.owner_scope_type='project' AND binding.owner_public_id=terms.project_public_id
    WHERE grant_record.id=? AND grant_record.access_terms_id IS NOT NULL
    GROUP BY terms.id HAVING count(*)>0
    ${requiredFallback}
    ON CONFLICT(producer_event_key) DO NOTHING`)
    .bind(input.id??crypto.randomUUID(),...proofValues,input.producerEventKey,input.eventKind,input.actor.type,input.actor.id,input.occurredAt??null,input.grantId,
      ...(requiredProofs.length?[crypto.randomUUID(),input.grantId,input.producerEventKey,input.actor.type,input.actor.id,input.occurredAt??null,
        input.grantId,input.grantId,input.grantId]:[]));
}

/** Records only current, still-live authorities whose exact term boundary has
 * elapsed. This history is independent of expiry-email feature state. */
export async function reconcileProjectAccessAuthorityExpiries(db:BatchDatabase,nowMs=Date.now(),limit=100,mutationsEnabled=false):Promise<number>{
  if(!mutationsEnabled)return 0;
  if(!await projectAccessAuthorityHistoryReady(db))return 0;
  const now=new Date(nowMs).toISOString(),bounded=Math.max(1,Math.min(250,Math.trunc(limit)));
  const rows=await db.prepare(`WITH authorities AS (
      SELECT DISTINCT 'invitation' authority_type,invitation.id authority_id,terms.id access_terms_id,
        CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END effective_expires_at
        ,invitation.status authority_status,invitation.revoked_at,invitation.created_at authority_created_at,invitation.accepted_at
      FROM portal_v2_invitations invitation
      JOIN portal_v2_invitation_entitlements entitlement ON entitlement.invitation_id=invitation.id
      JOIN portal_project_access_terms terms ON terms.id=entitlement.access_terms_id AND terms.workspace_id=invitation.workspace_id
      LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=terms.id
      WHERE invitation.status IN('accepted','revoked') AND invitation.accepted_by_identity_id IS NOT NULL
      UNION ALL
      SELECT 'authenticated_delivery_grant',grant_record.id,terms.id,
        CASE
          WHEN (CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END) IS NULL THEN grant_record.expires_at
          WHEN grant_record.expires_at IS NULL THEN (CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END)
          WHEN julianday(grant_record.expires_at)<julianday(CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END) THEN grant_record.expires_at
          ELSE (CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END) END
        ,grant_record.status,grant_record.revoked_at,grant_record.created_at,NULL
      FROM portal_v2_authenticated_delivery_grants grant_record
      JOIN portal_project_access_terms terms ON terms.id=grant_record.access_terms_id AND terms.workspace_id=grant_record.workspace_id
      LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=terms.id
      WHERE grant_record.status IN('active','expired','revoked')
    )
    SELECT authority_type,authority_id,access_terms_id,effective_expires_at FROM authorities
    JOIN portal_project_access_authority_history_state state ON state.singleton=1
    WHERE effective_expires_at IS NOT NULL AND julianday(effective_expires_at)<=julianday(?)
      AND julianday(effective_expires_at)>=julianday(state.collection_started_at)
      AND julianday(authority_created_at)<=julianday(effective_expires_at)
      AND (accepted_at IS NULL OR julianday(accepted_at)<=julianday(effective_expires_at))
      AND (authority_status IN('accepted','active','expired') OR julianday(revoked_at)>julianday(effective_expires_at))
      AND NOT EXISTS(SELECT 1 FROM portal_project_access_authority_events history
        WHERE history.authority_type=authorities.authority_type AND history.authority_id=authorities.authority_id
          AND history.access_terms_id=authorities.access_terms_id AND history.event_kind='access_expired')
    ORDER BY julianday(effective_expires_at),authority_type,authority_id LIMIT ?`)
    .bind(now,bounded).all<{authority_type:'invitation'|'authenticated_delivery_grant';authority_id:string;access_terms_id:string;effective_expires_at:string}>();
  let recorded=0;
  for(const row of rows.results){
    const key=`project-access-expired:${row.authority_type}:${row.authority_id}:${row.access_terms_id}:${row.effective_expires_at}`;
    const statement=row.authority_type==='invitation'
      ?projectAccessInvitationEvent(db,{invitationId:row.authority_id,eventKind:'access_expired',producerEventKey:key,actor:{type:'system',id:null},occurredAt:row.effective_expires_at})
      :projectAccessGrantEvent(db,{grantId:row.authority_id,eventKind:'access_expired',producerEventKey:key,actor:{type:'system',id:null},occurredAt:row.effective_expires_at});
    const result=await statement.run();
    recorded+=Number(result.meta.changes)===1?1:0;
  }
  return recorded;
}
