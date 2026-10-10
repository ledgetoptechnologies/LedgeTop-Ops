import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN=/^[0-9a-f]{64}$/;
const encoder=new TextEncoder();
type Owner=AuthenticatedNativeStaffWithAdmissionVersion;
type EnrollmentDb=Pick<D1Database,"prepare"|"batch">;
type Principal=Readonly<{issuer:string;subject:string}>;
type Target=Readonly<{clientRecordId:string;selectionId:string}>;
type IntentState="issued"|"pending"|"active"|"revoking"|"revoked";
type EnrollmentState=IntentState|"cancelled";
type IntentRow={intent_id:string;selection_id:string;target_client_record_id:string;token_sha256:string;state:IntentState;
  revision:number;access_issuer:string|null;access_subject:string|null;recipient_verified_until:string|null;
  binding_id:string|null;grant_operation_id:string|null;revoke_operation_id:string|null;expires_at:string};
type ExistingRow=IntentRow&{operation_revision:number;operation_state:IntentState};
type CancellationRow={cancellation_operation_id:string;cancellation_request_sha256:string;cancellation_prior_state:IntentState;
  cancellation_prior_revision:number;cancellation_resulting_revision:number;cancellation_actor_staff_id:string;
  cancellation_actor_access_subject:string;cancellation_actor_admission_version:number;cancellation_actor_profile_version:number;
  cancellation_actor_grant_generation:number};

export type RecipientEnrollmentReview=Readonly<{intentId:string;revision:number;state:EnrollmentState;
  target:Target;principal:Principal|null;expiresAt:string}>;
export type IssueRecipientEnrollmentIntentInput=Readonly<{target:Target;expiresAt:string;operationId:string;owner:Owner}>;
export type RedeemRecipientEnrollmentIntentInput=Readonly<{intentId:string;opaqueToken:string;principal:Principal;
  verifiedUntil:string;operationId:string;acknowledgedTarget:Target}>;
export type OwnerRecipientEnrollmentInput=Readonly<{intentId:string;expectedRevision:number;operationId:string;owner:Owner}>;
type CancellationReceipt=Readonly<{intentId:string;revision:number;state:"cancelled"}>;
type CancellationResult=Readonly<{review:RecipientEnrollmentReview|null;receipt:CancellationReceipt|null;operationId:string;replayed:boolean}>;

function text(value:unknown,max=512):value is string{return typeof value==="string"&&value.length>0&&value.length<=max
  &&value.trim()===value&&!value.includes("\0")}
function instant(value:unknown,future=true):value is string{if(typeof value!=="string"||value.length!==24)return false;
  const parsed=Date.parse(value);return Number.isFinite(parsed)&&new Date(parsed).toISOString()===value&&(!future||parsed>Date.now())}
async function sha(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))))
  .map(byte=>byte.toString(16).padStart(2,"0")).join("")}
const canonical=(action:string,value:unknown)=>JSON.stringify(["client-portal-recipient-enrollment-v1",action,value]);
function token(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return Array.from(bytes)
  .map(byte=>byte.toString(16).padStart(2,"0")).join("")}
function cancellation(row:IntentRow&Partial<CancellationRow>):CancellationRow|null{
  if(typeof row.cancellation_operation_id!=="string"||typeof row.cancellation_request_sha256!=="string"
    ||!(["issued","pending"] as string[]).includes(row.cancellation_prior_state as string)
    ||!Number.isSafeInteger(row.cancellation_prior_revision)||!Number.isSafeInteger(row.cancellation_resulting_revision)
    ||typeof row.cancellation_actor_staff_id!=="string"||typeof row.cancellation_actor_access_subject!=="string"
    ||!Number.isSafeInteger(row.cancellation_actor_admission_version)||!Number.isSafeInteger(row.cancellation_actor_profile_version)
    ||!Number.isSafeInteger(row.cancellation_actor_grant_generation))return null;
  const priorRevision=row.cancellation_prior_revision!,resultingRevision=row.cancellation_resulting_revision!;
  return {cancellation_operation_id:row.cancellation_operation_id,cancellation_request_sha256:row.cancellation_request_sha256,
    cancellation_prior_state:row.cancellation_prior_state as IntentState,cancellation_prior_revision:priorRevision,
    cancellation_resulting_revision:resultingRevision,cancellation_actor_staff_id:row.cancellation_actor_staff_id!,
    cancellation_actor_access_subject:row.cancellation_actor_access_subject!,cancellation_actor_admission_version:row.cancellation_actor_admission_version!,
    cancellation_actor_profile_version:row.cancellation_actor_profile_version!,cancellation_actor_grant_generation:row.cancellation_actor_grant_generation!};
}
function review(row:IntentRow,cancel?:CancellationRow|null):RecipientEnrollmentReview{const canceled=cancel!==null&&cancel!==undefined;return Object.freeze({intentId:row.intent_id,
  revision:canceled?cancel.cancellation_resulting_revision:row.revision,state:canceled?"cancelled":row.state,target:Object.freeze({clientRecordId:row.target_client_record_id,selectionId:row.selection_id}),
  principal:row.access_issuer&&row.access_subject?Object.freeze({issuer:row.access_issuer,subject:row.access_subject}):null,
  expiresAt:row.expires_at})}
async function generation(db:EnrollmentDb,owner:Owner){if(!instant(owner.verifiedUntil))throw Error("recipient_enrollment_denied");
  const value=await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
    .bind(owner.identity.staffId).first<number>("generation");
  if(value===null||!Number.isSafeInteger(value)||value<1)throw Error("recipient_enrollment_denied");return value}
async function existing(db:EnrollmentDb,operationId:string,digest:string,action:string){
  const row=await db.prepare(`SELECT i.*,o.resulting_revision operation_revision,o.resulting_state operation_state
    FROM client_portal_recipient_enrollment_operations o
    JOIN client_portal_recipient_enrollment_intents i ON i.intent_id=o.intent_id
    JOIN client_portal_recipient_enrollment_operation_commits committed ON committed.operation_id=o.operation_id
      AND committed.intent_id=o.intent_id
    WHERE o.operation_id=? AND o.action=? AND o.request_sha256=?`).bind(operationId,action,digest).first<ExistingRow>();
  if(!row)throw Error("recipient_enrollment_denied");return row}
function recordedReview(row:ExistingRow){return Object.freeze({...review(row),revision:row.operation_revision,state:row.operation_state,
  principal:row.operation_state==="issued"?null:review(row).principal})}
async function canceled(db:EnrollmentDb,intentId:string){return Boolean(await db.prepare(
  "SELECT 1 FROM client_portal_recipient_enrollment_cancellations WHERE intent_id=?").bind(intentId).first())}

export async function issueRecipientEnrollmentIntent(db:D1Database,input:IssueRecipientEnrollmentIntentInput){
  if(!UUID.test(input.operationId)||!text(input.target.clientRecordId,200)||!UUID.test(input.target.selectionId)
    ||!instant(input.expiresAt)||Date.parse(input.expiresAt)>Date.now()+7*86_400_000)throw Error("recipient_enrollment_denied");
  const session=db.withSession("first-primary"),grantGeneration=await generation(session,input.owner);
  const digest=await sha(canonical("issue",{target:input.target,expiresAt:input.expiresAt,staffId:input.owner.identity.staffId,
    accessSubject:input.owner.identity.verifiedAccessSubject,admissionVersion:input.owner.admissionVersion,
    profileVersion:input.owner.identity.profileVersion,grantGeneration}));
  const intentId=crypto.randomUUID(),opaqueToken=token(),tokenSha=await sha(opaqueToken);
  try{await session.batch([
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_intents
      (intent_id,selection_id,target_client_record_id,token_sha256,state,revision,issued_by_staff_id,issued_access_subject,
       issued_admission_version,issued_profile_version,issued_grant_generation,expires_at)
      SELECT ?,?,?,?,'issued',1,?,?,?,?,?,? FROM client_portal_workspace_binding_selections s
      JOIN client_portal_workspace_binding_outbox_receipts r ON r.operation_id=s.selection_id AND r.state='inactive' AND r.revision=1
      JOIN client_portal_workspace_binding_outbox b ON b.operation_id=r.operation_id AND b.state='acknowledged'
      JOIN operations_directory_records target ON target.record_id=? AND target.record_kind='client'
      JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=?
      JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=?
      JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id AND generation.generation=?
      WHERE s.selection_id=? AND (s.record_id=target.record_id OR EXISTS(SELECT 1 FROM operations_directory_client_organizations rel
        WHERE rel.client_record_id=target.record_id AND rel.organization_record_id=s.record_id))
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=a.staff_id AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=a.staff_id AND g.permission='directory.portal_access.manage'
        AND g.effect='allow' AND g.active=1 AND (g.scope_kind='global' OR (g.scope_kind='resource' AND g.resource_id=s.record_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=a.staff_id AND d.permission='directory.portal_access.manage'
        AND d.effect='deny' AND d.active=1 AND (d.scope_kind='global' OR (d.scope_kind='resource' AND d.resource_id=s.record_id)
          OR (d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes z WHERE z.record_id=s.record_id AND z.active=1 AND z.business_area_id=d.business_area_id))
          OR (d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes z WHERE z.record_id=s.record_id AND z.active=1 AND z.division_id=d.division_id))))`)
      .bind(intentId,input.target.selectionId,input.target.clientRecordId,tokenSha,input.owner.identity.staffId,
        input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,input.owner.identity.profileVersion,grantGeneration,
        input.expiresAt,input.target.clientRecordId,input.owner.identity.staffId,input.owner.identity.verifiedAccessSubject,
        input.owner.admissionVersion,input.owner.identity.profileVersion,grantGeneration,input.target.selectionId),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(operation_id,intent_id,action,request_sha256,
      resulting_revision,resulting_state,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
      actor_grant_generation,actor_verified_until)
      VALUES(?,?,'issue',?,1,'issued',?,?,?,?,?,?)`).bind(input.operationId,intentId,digest,input.owner.identity.staffId,
        input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,input.owner.identity.profileVersion,grantGeneration,input.owner.verifiedUntil),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)`)
      .bind(input.operationId,intentId),
  ]);return{...review((await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(intentId).first<IntentRow>())!),opaqueToken,replayed:false as const};}
  catch{const row=await existing(session,input.operationId,digest,"issue");
    if(!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
    // A cancellation is terminal for the intent: do not replay an old issued
    // view as if its opaque token were still usable. The explicit contract is
    // denial plus fresh issue, preserving the immutable operation row without
    // exposing or regenerating the one-time token.
    if(await canceled(session,row.intent_id))throw Error("recipient_enrollment_denied");
    return{...recordedReview(row),replayed:true as const};}
}

export async function redeemRecipientEnrollmentIntent(db:D1Database,input:RedeemRecipientEnrollmentIntentInput){
  if(!UUID.test(input.intentId)||!UUID.test(input.operationId)||!TOKEN.test(input.opaqueToken)||!text(input.principal.issuer)
    ||!text(input.principal.subject)||!instant(input.verifiedUntil)||!text(input.acknowledgedTarget.clientRecordId,200)
    ||!UUID.test(input.acknowledgedTarget.selectionId))throw Error("recipient_enrollment_denied");
  const session=db.withSession("first-primary"),tokenSha=await sha(input.opaqueToken),digest=await sha(canonical("redeem",{
    intentId:input.intentId,tokenSha,principal:input.principal,acknowledgedTarget:input.acknowledgedTarget}));
  try{await session.batch([
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operations
      (operation_id,intent_id,action,request_sha256,resulting_revision,resulting_state)
      SELECT ?,?,'redeem',?,2,'pending' FROM client_portal_recipient_enrollment_intents
      WHERE intent_id=? AND token_sha256=? AND state='issued' AND revision=1 AND target_client_record_id=? AND selection_id=?
        AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=client_portal_recipient_enrollment_intents.intent_id)
        AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(input.operationId,input.intentId,digest,input.intentId,tokenSha,input.acknowledgedTarget.clientRecordId,
        input.acknowledgedTarget.selectionId,input.verifiedUntil),
    session.prepare(`UPDATE client_portal_recipient_enrollment_intents SET state='pending',revision=2,access_issuer=?,access_subject=?,
      recipient_verified_until=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND token_sha256=? AND state='issued'
      AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=client_portal_recipient_enrollment_intents.intent_id)
      AND revision=1 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(input.principal.issuer,input.principal.subject,
        input.verifiedUntil,input.intentId,tokenSha,input.verifiedUntil),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)`)
      .bind(input.operationId,input.intentId),
  ]);const row=await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=? AND state='pending' AND revision=2")
    .bind(input.intentId).first<IntentRow>();if(!row)throw Error();return{review:review(row),replayed:false as const};}
  catch{
    // Redeem history remains immutable, but a canceled intent cannot replay a
    // past pending result: doing so could make stale recipient proof look
    // current. The caller must issue and redeem a fresh intent.
    if(await canceled(session,input.intentId))throw Error("recipient_enrollment_denied");
    const row=await existing(session,input.operationId,digest,"redeem");return{review:recordedReview(row),replayed:true as const};}
}

export async function inspectRecipientEnrollmentIntent(db:D1Database,intentId:string,opaqueToken:string){
  if(!UUID.test(intentId)||!TOKEN.test(opaqueToken))throw Error("recipient_enrollment_denied");
  const tokenSha=await sha(opaqueToken),row=await db.withSession("first-primary")
    .prepare(`SELECT i.*,json_extract(revision.profile_json,'$.name') display_label
      FROM client_portal_recipient_enrollment_intents i
      JOIN operations_directory_records record ON record.record_id=i.target_client_record_id AND record.record_kind='client'
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      WHERE i.intent_id=? AND i.token_sha256=? AND i.state='issued'
        AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=i.intent_id)`).bind(intentId,tokenSha)
    .first<IntentRow&{display_label:string}>();
  if(!row||!text(row.display_label,160))throw Error("recipient_enrollment_denied");
  return Object.freeze({...review(row),target:Object.freeze({...review(row).target,displayLabel:row.display_label})})}

async function ownerAuthorized(db:EnrollmentDb,intentId:string,owner:Owner,grantGeneration:number){
  return Boolean(await db.prepare(`SELECT 1 FROM client_portal_recipient_enrollment_intents i
    JOIN client_portal_workspace_binding_selections s ON s.selection_id=i.selection_id
    JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=?
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id AND generation.generation=?
    WHERE i.intent_id=? AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=a.staff_id
      AND role.role_id='role-owner' AND role.scope='global')
    AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=a.staff_id AND g.permission='directory.portal_access.manage'
      AND g.effect='allow' AND g.active=1 AND (g.scope_kind='global' OR (g.scope_kind='resource' AND g.resource_id=s.record_id)))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=a.staff_id
      AND d.permission='directory.portal_access.manage' AND d.effect='deny' AND d.active=1
      AND (d.scope_kind='global' OR (d.scope_kind='resource' AND d.resource_id=s.record_id)
        OR (d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes z
          WHERE z.record_id=s.record_id AND z.active=1 AND z.business_area_id=d.business_area_id))
        OR (d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes z
          WHERE z.record_id=s.record_id AND z.active=1 AND z.division_id=d.division_id))))`)
    .bind(owner.identity.staffId,owner.identity.verifiedAccessSubject,owner.admissionVersion,owner.identity.profileVersion,
      grantGeneration,intentId).first())}
async function currentOwnerActorAuthorized(db:EnrollmentDb,owner:Owner,grantGeneration:number){
  return Boolean(await db.prepare(`SELECT 1 FROM native_staff_admissions a
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id AND generation.generation=?
    WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=a.staff_id
        AND role.role_id='role-owner' AND role.scope='global')`)
    .bind(owner.identity.profileVersion,grantGeneration,owner.identity.staffId,owner.identity.verifiedAccessSubject,owner.admissionVersion).first())}

export async function readRecipientEnrollmentIntentForOwner(db:D1Database,intentId:string,owner:Owner){
  if(!UUID.test(intentId))throw Error("recipient_enrollment_denied");const session=db.withSession("first-primary"),g=await generation(session,owner);
  if(!await ownerAuthorized(session,intentId,owner,g))throw Error("recipient_enrollment_denied");
  const row=await session.prepare(`SELECT i.*,c.operation_id cancellation_operation_id,c.request_sha256 cancellation_request_sha256,
      c.prior_state cancellation_prior_state,c.prior_revision cancellation_prior_revision,c.resulting_revision cancellation_resulting_revision,
      c.actor_staff_id cancellation_actor_staff_id,c.actor_access_subject cancellation_actor_access_subject,
      c.actor_admission_version cancellation_actor_admission_version,c.actor_profile_version cancellation_actor_profile_version,
      c.actor_grant_generation cancellation_actor_grant_generation
      FROM client_portal_recipient_enrollment_intents i LEFT JOIN client_portal_recipient_enrollment_cancellations c ON c.intent_id=i.intent_id
      WHERE i.intent_id=?`).bind(intentId).first<IntentRow&Partial<CancellationRow>>();
  if(!row)throw Error("recipient_enrollment_denied");return review(row,cancellation(row))}

export async function listRecipientEnrollmentIntentsForOwner(db:D1Database,owner:Owner){const session=db.withSession("first-primary"),g=await generation(session,owner);
  const rows=await session.prepare(`SELECT i.*,c.operation_id cancellation_operation_id,c.request_sha256 cancellation_request_sha256,
      c.prior_state cancellation_prior_state,c.prior_revision cancellation_prior_revision,c.resulting_revision cancellation_resulting_revision,
      c.actor_staff_id cancellation_actor_staff_id,c.actor_access_subject cancellation_actor_access_subject,
      c.actor_admission_version cancellation_actor_admission_version,c.actor_profile_version cancellation_actor_profile_version,
      c.actor_grant_generation cancellation_actor_grant_generation
    FROM client_portal_recipient_enrollment_intents i LEFT JOIN client_portal_recipient_enrollment_cancellations c ON c.intent_id=i.intent_id
    JOIN client_portal_workspace_binding_selections s ON s.selection_id=i.selection_id
    JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=?
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id AND generation.generation=?
    WHERE i.state IN ('issued','pending','active','revoking') AND c.intent_id IS NULL
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=a.staff_id AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=a.staff_id
        AND grant_row.permission='directory.portal_access.manage' AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=s.record_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=a.staff_id
        AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=s.record_id)
          OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes z
            WHERE z.record_id=s.record_id AND z.active=1 AND z.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes z
            WHERE z.record_id=s.record_id AND z.active=1 AND z.division_id=deny.division_id))))
    ORDER BY i.created_at,i.intent_id LIMIT 101`).bind(owner.identity.staffId,owner.identity.verifiedAccessSubject,
      owner.admissionVersion,owner.identity.profileVersion,g).all<IntentRow&Partial<CancellationRow>>();
  if(!rows.success||rows.results.length>100)throw Error("recipient_enrollment_denied");
  return rows.results.map(row=>review(row,cancellation(row)))}

async function ownerDigest(db:EnrollmentDb,action:string,input:OwnerRecipientEnrollmentInput){
  if(!UUID.test(input.intentId)||!UUID.test(input.operationId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)
    throw Error("recipient_enrollment_denied");
  const grantGeneration=await generation(db,input.owner),digest=await sha(canonical(action,{intentId:input.intentId,
    expectedRevision:input.expectedRevision,staffId:input.owner.identity.staffId,
    accessSubject:input.owner.identity.verifiedAccessSubject,admissionVersion:input.owner.admissionVersion,
  profileVersion:input.owner.identity.profileVersion,grantGeneration}));return{grantGeneration,digest}}

export async function cancelRecipientEnrollmentIntent(db:D1Database,input:OwnerRecipientEnrollmentInput){
  const session=db.withSession("first-primary"),{grantGeneration,digest}=await ownerDigest(session,"cancel",input);
  const row=await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>();
  if(!row||!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
    const prior=await session.prepare(`SELECT operation_id cancellation_operation_id,request_sha256 cancellation_request_sha256,
      prior_state cancellation_prior_state,prior_revision cancellation_prior_revision,resulting_revision cancellation_resulting_revision,
      actor_staff_id cancellation_actor_staff_id,actor_access_subject cancellation_actor_access_subject,
      actor_admission_version cancellation_actor_admission_version,actor_profile_version cancellation_actor_profile_version,
      actor_grant_generation cancellation_actor_grant_generation
      FROM client_portal_recipient_enrollment_cancellations WHERE intent_id=?`).bind(input.intentId)
    .first<CancellationRow>();
  if(prior){
    const historicalDigest=await sha(canonical("cancel",{intentId:input.intentId,expectedRevision:input.expectedRevision,
      staffId:prior.cancellation_actor_staff_id,accessSubject:prior.cancellation_actor_access_subject,
      admissionVersion:prior.cancellation_actor_admission_version,profileVersion:prior.cancellation_actor_profile_version,
      grantGeneration:prior.cancellation_actor_grant_generation}));
    if(prior.cancellation_operation_id!==input.operationId||prior.cancellation_request_sha256!==historicalDigest
      ||prior.cancellation_prior_revision!==input.expectedRevision
      ||prior.cancellation_actor_staff_id!==input.owner.identity.staffId
      ||prior.cancellation_actor_access_subject!==input.owner.identity.verifiedAccessSubject
      ||prior.cancellation_actor_admission_version!==input.owner.admissionVersion
      ||prior.cancellation_actor_profile_version!==input.owner.identity.profileVersion
      ||!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
    return{review:review(row,prior),receipt:null,operationId:input.operationId,replayed:true as const};
  }
  if(!["issued","pending"].includes(row.state)||row.revision!==input.expectedRevision
    ||row.binding_id||row.grant_operation_id||row.revoke_operation_id)throw Error("recipient_enrollment_denied");
  const resultingRevision=input.expectedRevision+1;
  try{await session.prepare(`INSERT INTO client_portal_recipient_enrollment_cancellations
      (intent_id,operation_id,request_sha256,prior_state,prior_revision,resulting_revision,actor_staff_id,actor_access_subject,
       actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.intentId,input.operationId,digest,row.state,input.expectedRevision,resultingRevision,
        input.owner.identity.staffId,input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,input.owner.identity.profileVersion,
        grantGeneration,input.owner.verifiedUntil).run();
    const marker=await session.prepare(`SELECT operation_id cancellation_operation_id,request_sha256 cancellation_request_sha256,
      prior_state cancellation_prior_state,prior_revision cancellation_prior_revision,resulting_revision cancellation_resulting_revision,
      actor_staff_id cancellation_actor_staff_id,actor_access_subject cancellation_actor_access_subject,
      actor_admission_version cancellation_actor_admission_version,actor_profile_version cancellation_actor_profile_version,
      actor_grant_generation cancellation_actor_grant_generation
      FROM client_portal_recipient_enrollment_cancellations WHERE intent_id=?`).bind(input.intentId).first<CancellationRow>();
    if(!marker)throw Error("recipient_enrollment_denied");
    return{review:review(row,marker),receipt:null,operationId:input.operationId,replayed:false as const};
  }catch{
    const marker=await session.prepare(`SELECT operation_id cancellation_operation_id,request_sha256 cancellation_request_sha256,
      prior_state cancellation_prior_state,prior_revision cancellation_prior_revision,resulting_revision cancellation_resulting_revision,
      actor_staff_id cancellation_actor_staff_id,actor_access_subject cancellation_actor_access_subject,
      actor_admission_version cancellation_actor_admission_version,actor_profile_version cancellation_actor_profile_version,
      actor_grant_generation cancellation_actor_grant_generation
      FROM client_portal_recipient_enrollment_cancellations WHERE intent_id=?`).bind(input.intentId).first<CancellationRow>();
    if(!marker||marker.cancellation_operation_id!==input.operationId||marker.cancellation_prior_revision!==input.expectedRevision)throw Error("recipient_enrollment_denied");
    const historicalDigest=await sha(canonical("cancel",{intentId:input.intentId,expectedRevision:input.expectedRevision,
      staffId:marker.cancellation_actor_staff_id,accessSubject:marker.cancellation_actor_access_subject,
      admissionVersion:marker.cancellation_actor_admission_version,profileVersion:marker.cancellation_actor_profile_version,
      grantGeneration:marker.cancellation_actor_grant_generation}));
    if(marker.cancellation_request_sha256!==historicalDigest||marker.cancellation_actor_staff_id!==input.owner.identity.staffId
      ||marker.cancellation_actor_access_subject!==input.owner.identity.verifiedAccessSubject
      ||marker.cancellation_actor_admission_version!==input.owner.admissionVersion
      ||marker.cancellation_actor_profile_version!==input.owner.identity.profileVersion
      ||!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
    return{review:review(row,marker),receipt:null,operationId:input.operationId,replayed:true as const};
  }
}

export async function confirmRecipientEnrollmentIntent(db:D1Database,input:OwnerRecipientEnrollmentInput){
  const session=db.withSession("first-primary"),{grantGeneration,digest}=await ownerDigest(session,"confirm",input);
  if(await canceled(session,input.intentId))throw Error("recipient_enrollment_denied");
  const row=await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>();
  if(row&&!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
  if(!row||row.state!=="pending"||row.revision!==input.expectedRevision||!row.access_issuer||!row.access_subject
    ||!instant(row.recipient_verified_until)||Date.parse(row.expires_at)<=Date.now()){
    const prior=await existing(session,input.operationId,digest,"confirm");return{review:recordedReview(prior),operationId:prior.grant_operation_id!,replayed:true as const};}
  const bindingId=crypto.randomUUID();
  try{await session.batch([
    session.prepare(`INSERT INTO client_onboarding_recipient_identity_bindings
      (binding_id,target_client_record_id,access_issuer,access_subject,status,expires_at)
      SELECT ?,target_client_record_id,access_issuer,access_subject,'active',NULL
      FROM client_portal_recipient_enrollment_intents WHERE intent_id=? AND state='pending' AND revision=?
        AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=client_portal_recipient_enrollment_intents.intent_id)
        AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND recipient_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(bindingId,input.intentId,input.expectedRevision),
    session.prepare(`INSERT INTO client_portal_authority_v2_outbox(operation_id,binding_operation_id,client_authority_id,workspace_id,
      recipient_binding_id,issuer,subject,desired_state,expected_ownership_epoch,expected_grant_revision,authorized_by_staff_id,
      authorized_access_subject,authorized_admission_version,authorized_profile_version,authorized_grant_generation,protocol_version,permissions_json)
       SELECT ?,s.selection_id,s.client_authority_id,s.workspace_id,?,?,?,'active',0,0,?,?,?,?,?,3,'["operations.service_home.read"]'
       FROM client_portal_workspace_binding_selections s JOIN client_portal_workspace_binding_outbox_receipts r
        ON r.operation_id=s.selection_id AND r.state='inactive' AND r.revision=1
      JOIN client_portal_workspace_binding_outbox b ON b.operation_id=r.operation_id AND b.state='acknowledged'
       WHERE s.selection_id=? AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=?)`).bind(input.operationId,bindingId,row.access_issuer,row.access_subject,input.owner.identity.staffId,
        input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,input.owner.identity.profileVersion,grantGeneration,row.selection_id,input.intentId),
    session.prepare(`INSERT INTO client_portal_authority_v2_outbox_audit(operation_id,action,authorized_by_staff_id,authorized_grant_generation)
      VALUES(?,'v2.intent.enqueued',?,?)`).bind(input.operationId,input.owner.identity.staffId,grantGeneration),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(operation_id,intent_id,action,request_sha256,resulting_revision,
      resulting_state,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,
      actor_verified_until)
      VALUES(?,?,'confirm',?,?,'active',?,?,?,?,?,?)`).bind(input.operationId,input.intentId,digest,
        input.expectedRevision+1,input.owner.identity.staffId,input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,
        input.owner.identity.profileVersion,grantGeneration,input.owner.verifiedUntil),
    session.prepare(`UPDATE client_portal_recipient_enrollment_intents SET state='active',revision=revision+1,binding_id=?,grant_operation_id=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND state='pending' AND revision=?
      AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=client_portal_recipient_enrollment_intents.intent_id)
      AND recipient_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(bindingId,input.operationId,input.intentId,input.expectedRevision),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)`)
      .bind(input.operationId,input.intentId),
  ]);return{review:review((await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>())!),operationId:input.operationId,replayed:false as const};}
  catch{const prior=await existing(session,input.operationId,digest,"confirm");return{review:recordedReview(prior),operationId:prior.grant_operation_id!,replayed:true as const};}
}

export async function revokeRecipientEnrollmentBinding(db:D1Database,input:OwnerRecipientEnrollmentInput){
  const session=db.withSession("first-primary"),{grantGeneration,digest}=await ownerDigest(session,"revoke",input);
  const row=await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>();
  if(row&&!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
  if(!row||row.state!=="active"||row.revision!==input.expectedRevision||!row.binding_id||!row.grant_operation_id
    ||!row.access_issuer||!row.access_subject){const prior=await existing(session,input.operationId,digest,"revoke");
    return{review:recordedReview(prior),operationId:prior.revoke_operation_id!,replayed:true as const};}
  const authority=await session.prepare(`SELECT r.client_authority_id,r.workspace_id,r.ownership_epoch,r.grant_revision
    FROM client_portal_authority_v2_outbox_receipts r JOIN client_portal_authority_v2_outbox o ON o.operation_id=r.operation_id
    WHERE o.binding_operation_id=? AND o.recipient_binding_id=? AND r.issuer=? AND r.subject=? AND o.state='acknowledged'
    ORDER BY r.ownership_epoch DESC,r.grant_revision DESC LIMIT 1`).bind(row.selection_id,row.binding_id,row.access_issuer,row.access_subject)
    .first<{client_authority_id:string;workspace_id:string;ownership_epoch:number;grant_revision:number}>();
  if(!authority)throw Error("recipient_enrollment_denied");
  try{await session.batch([
    session.prepare(`INSERT INTO client_portal_authority_v2_outbox(operation_id,binding_operation_id,client_authority_id,workspace_id,
      recipient_binding_id,issuer,subject,desired_state,expected_ownership_epoch,expected_grant_revision,authorized_by_staff_id,
      authorized_access_subject,authorized_admission_version,authorized_profile_version,authorized_grant_generation,protocol_version,permissions_json)
      VALUES(?,?,?,?,?,?,?,'revoked',?,?,?,?,?,?,?,3,'[]')`).bind(input.operationId,row.selection_id,authority.client_authority_id,
        authority.workspace_id,row.binding_id,row.access_issuer,row.access_subject,authority.ownership_epoch,authority.grant_revision,
        input.owner.identity.staffId,input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,
        input.owner.identity.profileVersion,grantGeneration),
    session.prepare(`INSERT INTO client_portal_authority_v2_outbox_audit(operation_id,action,authorized_by_staff_id,authorized_grant_generation)
      VALUES(?,'v2.intent.enqueued',?,?)`).bind(input.operationId,input.owner.identity.staffId,grantGeneration),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(operation_id,intent_id,action,request_sha256,resulting_revision,
      resulting_state,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,
      actor_verified_until)
      VALUES(?,?,'revoke',?,?,'revoking',?,?,?,?,?,?)`).bind(input.operationId,input.intentId,digest,
        input.expectedRevision+1,input.owner.identity.staffId,input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,
        input.owner.identity.profileVersion,grantGeneration,input.owner.verifiedUntil),
    session.prepare(`UPDATE client_portal_recipient_enrollment_intents SET state='revoking',revision=revision+1,revoke_operation_id=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND state='active' AND revision=?`)
      .bind(input.operationId,input.intentId,input.expectedRevision),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)`)
      .bind(input.operationId,input.intentId),
  ]);return{review:review((await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>())!),operationId:input.operationId,replayed:false as const};}
  catch{const prior=await existing(session,input.operationId,digest,"revoke");return{review:recordedReview(prior),operationId:prior.revoke_operation_id!,replayed:true as const};}
}

export async function reconcileRecipientEnrollmentRevocation(db:D1Database,input:OwnerRecipientEnrollmentInput){
  const session=db.withSession("first-primary"),{grantGeneration,digest}=await ownerDigest(session,"finalize_revoke",input);
  const row=await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>();
  if(row&&!await ownerAuthorized(session,row.intent_id,input.owner,grantGeneration))throw Error("recipient_enrollment_denied");
  if(!row||row.state!=="revoking"||row.revision!==input.expectedRevision||!row.binding_id||!row.revoke_operation_id)
    {const prior=await existing(session,input.operationId,digest,"finalize_revoke");return{review:recordedReview(prior),replayed:true as const};}
  try{await session.batch([
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(operation_id,intent_id,action,request_sha256,resulting_revision,
      resulting_state,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,
      actor_verified_until)
      VALUES(?,?,'finalize_revoke',?,?,'revoked',?,?,?,?,?,?)`).bind(input.operationId,input.intentId,digest,
        input.expectedRevision+1,input.owner.identity.staffId,input.owner.identity.verifiedAccessSubject,input.owner.admissionVersion,
        input.owner.identity.profileVersion,grantGeneration,input.owner.verifiedUntil),
    session.prepare(`UPDATE client_onboarding_recipient_identity_bindings SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE binding_id=? AND status='active' AND EXISTS(
        SELECT 1 FROM client_portal_authority_v2_outbox o JOIN client_portal_authority_v2_outbox_receipts r ON r.operation_id=o.operation_id
        WHERE o.operation_id=? AND o.state='acknowledged' AND o.recipient_binding_id=? AND o.binding_operation_id=?
          AND o.issuer=? AND o.subject=? AND o.desired_state='revoked' AND o.protocol_version=3 AND o.permissions_json='[]'
          AND r.client_authority_id=o.client_authority_id AND r.workspace_id=o.workspace_id
          AND r.issuer=o.issuer AND r.subject=o.subject AND r.ownership_epoch=o.expected_ownership_epoch
          AND r.grant_revision=o.expected_grant_revision+1 AND r.resulting_state='revoked'
          AND r.protocol_version=3 AND r.permissions_json='[]')`)
      .bind(row.binding_id,row.revoke_operation_id,row.binding_id,row.selection_id,row.access_issuer,row.access_subject),
    session.prepare(`UPDATE client_portal_recipient_enrollment_intents SET state='revoked',revision=revision+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND state='revoking' AND revision=? AND changes()=1`)
      .bind(input.intentId,input.expectedRevision),
    session.prepare(`INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)`)
      .bind(input.operationId,input.intentId),
  ]);return{review:review((await session.prepare("SELECT * FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
    .bind(input.intentId).first<IntentRow>())!),replayed:false as const};}
  catch{const prior=await existing(session,input.operationId,digest,"finalize_revoke");return{review:recordedReview(prior),replayed:true as const};}
}
