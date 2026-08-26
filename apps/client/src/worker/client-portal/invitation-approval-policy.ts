import {HTTPException} from 'hono/http-exception';

const objects=['portal_workspace_invitation_requests','portal_workspace_invitation_request_commands',
 'portal_workspace_invitation_approvals','portal_workspace_invitation_request_audit',
 'portal_workspace_invitation_approval_fences','portal_workspace_invitation_publications'];
export async function invitationRequestsReady(db:Pick<D1Database,'prepare'>):Promise<boolean>{
 const rows=(await db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${objects.map(()=>'?').join(',')})`).bind(...objects).all<{name:string}>()).results;
 if(!rows.length)return false;
 if(rows.length!==objects.length)throw new HTTPException(503,{message:'invitation_requests_unavailable'});
 return true;
}
/** Internal SQL expressions only. A tracked staged invitation never falls
 * through to legacy Allowed behavior, including after a policy change. */
export function invitationPublicationSql(invitationAlias:string):string{
 return `(CASE WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals publication_owner WHERE publication_owner.invitation_id=${invitationAlias}.id)
  THEN EXISTS(SELECT 1 FROM portal_workspace_invitation_publications published_invite WHERE published_invite.invitation_id=${invitationAlias}.id AND published_invite.published=1)
  ELSE NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_policies invitation_policy WHERE invitation_policy.workspace_id=${invitationAlias}.workspace_id AND invitation_policy.policy<>'allowed') END)`;
}
export async function invitationPublicationAllowed(db:Pick<D1Database,'prepare'>,invitationId:string):Promise<boolean>{
 if(!await invitationRequestsReady(db))return true;
 return (await db.prepare(`SELECT ${invitationPublicationSql('invitation')} allowed FROM portal_v2_invitations invitation WHERE invitation.id=?`)
  .bind(invitationId).first<number>('allowed'))===1;
}
