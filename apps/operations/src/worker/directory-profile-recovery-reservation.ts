/** Profile-successor provenance only. This is not authorization: dispatch must
 * still run its original exactReservation, including fresh portal authority. */
export async function directoryProfileRecoveryLineage(db:D1Database,commandId:string){
 if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_alpha_directory_profile_generation_recoveries'").first())return null;
 return db.prepare(`SELECT x.authorization_id,x.root_command_id,root.command_json root_command_json,x.actor_json,x.endpoint_policy,x.observed_identity_json,x.identity_policy
 FROM project_alpha_directory_profile_generation_recoveries x JOIN project_alpha_directory_outbox root ON root.command_id=x.root_command_id
 JOIN project_alpha_directory_outbox child ON child.command_id=x.successor_command_id AND child.command_json=x.successor_command_json
 WHERE x.successor_command_id=?`).bind(commandId).first<{authorization_id:string;root_command_id:string;root_command_json:string;actor_json:string;endpoint_policy:'regular'|'contact';observed_identity_json:string|null;identity_policy:'staff'|'reviewed_manual'|'automatic_own'}>();
}

type Scalar=string|number|null;
type Fence={sql:string;values:Scalar[];rows:Record<string,Scalar>[];columns:string[]};
export type ProfileRecoverySnapshot=Readonly<{fences:readonly Fence[];capturedAt:number}>;
type Context={recordId:string;sourceId:string;externalId:string;publicId:string;staffId:string|null;groupId:string|null};
const identifier=/^[a-z_][a-z0-9_]*$/;
// These are fixed schema-owned tables/views, never caller-supplied identifiers.
// Full ordered rowsets capture additions as well as removals. Grant generation
// invalidates every allow/deny flip; assignments and scopes have separate fences.
export async function captureProfileRecoverySnapshot(db:D1Database,c:Context):Promise<ProfileRecoverySnapshot|null>{
 try{
  const specs:Array<[string,string,Scalar[]]>=[
   ['operations_directory_records','record_id IN(SELECT value FROM json_each(?))',[]],
   ['effective_native_directory_enrollments','record_id IN(SELECT value FROM json_each(?))',[]],
   ['operations_directory_lifecycle_state','record_id IN(SELECT value FROM json_each(?))',[]],
   ['operations_directory_client_organizations','client_record_id IN(SELECT value FROM json_each(?))',[]],
   ['native_directory_resource_scopes','record_id IN(SELECT value FROM json_each(?))',[]],
   ['native_directory_assignments','record_id IN(SELECT value FROM json_each(?))',[]],
   ['project_alpha_active_directory_mappings','record_id IN(SELECT value FROM json_each(?)) OR (source_id=? AND (external_id=? OR project_alpha_public_id=?))',[]],
   ['operations_directory_intents','record_id IN(SELECT value FROM json_each(?)) AND record_version>=(SELECT current_version-1 FROM operations_directory_records r WHERE r.record_id=a.record_id)',[]],
   ['operations_directory_intent_relationship_dependencies','client_record_id IN(SELECT value FROM json_each(?))',[]],
   ['operations_directory_revisions','record_id IN(SELECT value FROM json_each(?)) AND version>=(SELECT current_version-1 FROM operations_directory_records r WHERE r.record_id=a.record_id)',[]],
   ['project_alpha_directory_outbox',`command_id IN(SELECT m.command_id FROM operations_directory_materializations m JOIN operations_directory_intents i ON i.intent_id=m.intent_id
     JOIN operations_directory_records r ON r.record_id=i.record_id WHERE i.record_id IN(SELECT value FROM json_each(?)) AND i.record_version>=r.current_version-1)
    OR command_id IN(SELECT e.successor_command_id FROM project_alpha_directory_profile_recovery_edges e JOIN operations_directory_intents i ON i.intent_id=e.intent_id
     JOIN operations_directory_records r ON r.record_id=i.record_id WHERE i.record_id IN(SELECT value FROM json_each(?)) AND i.record_version>=r.current_version-1)`,[]],
   ['project_alpha_existing_directory_binding_revision_refresh_receipts','record_id IN(SELECT value FROM json_each(?))',[]],
   ['project_alpha_existing_directory_binding_revision_refresh_commands','record_id IN(SELECT value FROM json_each(?))',[]],
   ['project_alpha_existing_directory_binding_activation_receipts','record_id IN(SELECT value FROM json_each(?))',[]],
   ['project_alpha_acquired_native_owner_claims','record_id IN(SELECT value FROM json_each(?))',[]],
   ['native_directory_shared_profile_members','group_id=?',[c.groupId]],
   ['native_directory_shared_profiles','id=?',[c.groupId]],
   ['native_directory_shared_profile_commands','group_id=? AND expected_version=(SELECT version-1 FROM native_directory_shared_profiles g WHERE g.id=a.group_id)',[c.groupId]],
   ['shared_profile_portal_grants','group_id=?',[c.groupId]],
   ['shared_profile_portal_authority_heads','workspace_id IN(SELECT workspace_id FROM shared_profile_portal_grants WHERE group_id=?)',[c.groupId]],
   ['shared_profile_portal_write_fences','group_id=?',[c.groupId]],
   ['client_onboarding_portal_activation_proofs','grant_id IN(SELECT id FROM shared_profile_portal_grants WHERE group_id=?)',[c.groupId]],
   ['portal_directory_correspondence_heads','1=1',[]],
   ['portal_directory_correspondence_revisions','id IN(SELECT revision_id FROM portal_directory_correspondence_heads)',[]],
   ['native_directory_grant_generations','staff_id=?',[c.staffId]],
   ['native_staff_admissions','staff_id=?',[c.staffId]],
   ['native_staff_profiles','staff_id=?',[c.staffId]],
  ];
  const members=(await db.prepare('SELECT record_id FROM native_directory_shared_profile_members WHERE group_id=? ORDER BY record_id').bind(c.groupId).all<{record_id:string}>()).results;
  const ids=new Set([c.recordId,...members.map(m=>m.record_id)]);
  const parents=(await db.prepare('SELECT organization_record_id FROM operations_directory_client_organizations WHERE client_record_id IN(SELECT value FROM json_each(?)) AND organization_record_id IS NOT NULL')
   .bind(JSON.stringify([...ids])).all<{organization_record_id:string}>()).results;
  for(const p of parents)ids.add(p.organization_record_id);
  if(ids.size>64)return null;const idJson=JSON.stringify([...ids].sort()),fences:Fence[]=[];
  const definitions=await db.batch<{name:string}>(specs.map(([table])=>db.prepare(`PRAGMA table_info('${table}')`)));
  const pending:Array<Omit<Fence,'rows'>>=[];
  for(const [index,[table,where,parameters]]of specs.entries()){
   // The normal Client coordinator renews operation_id/updated_at while proving
   // the same active revision. Fence every authority field, not renewal bookkeeping.
   const columns=table==='shared_profile_portal_authority_heads'
    ?['workspace_id','source_id','revision','state']:definitions[index]!.results.map(r=>r.name);
   if(!columns.length||columns.some(col=>!identifier.test(col)))return null;
   const values=table==='project_alpha_active_directory_mappings'?[idJson,c.sourceId,c.externalId,c.publicId]
    :parameters.length?parameters:Array.from(where.matchAll(/json_each\(\?\)/g),()=>idJson);
   const sql=`SELECT ${columns.map(col=>`a.${col}`).join(',')} FROM ${table} a WHERE ${where}`;
   pending.push({sql,values,columns});
  }
  const captured=await db.batch<Record<string,Scalar>>(pending.map(f=>db.prepare(`${f.sql} ORDER BY ${f.columns.map(col=>`a.${col}`).join(',')} LIMIT 513`).bind(...f.values)));
  for(const[index,f]of pending.entries()){const rows=captured[index]!.results;if(rows.length>512||JSON.stringify(rows).length>128*1024)return null;fences.push({...f,rows});}
  // Only semantic staff fields: ordinary last-seen updates are not authority.
  const staffSql='SELECT id,status,access_subject FROM staff_users WHERE id=?';
  fences.push({sql:staffSql,values:[c.staffId],rows:(await db.prepare(staffSql).bind(c.staffId).all<Record<string,Scalar>>()).results,columns:['id','status','access_subject']});
  // Connector projections contain volatile poll timestamps, so explicitly keep
  // only every field used by correspondence eligibility/currentProof.
  for(const sql of [
   'SELECT source_id,producer_binding_id,snapshot_origin,application_key,active_revision,version,profile,state,read_visible FROM pa_connectors ORDER BY source_id',
   'SELECT source_id,revision,current_key_fingerprint FROM pa_connector_revisions r WHERE revision=(SELECT active_revision FROM pa_connectors c WHERE c.source_id=r.source_id) ORDER BY source_id,revision',
  ]){
   const rows=(await db.prepare(sql).all<Record<string,Scalar>>()).results;if(rows.length>512)return null;
   fences.push({sql,values:[],rows,columns:rows.length?Object.keys(rows[0]!):sql.slice(7,sql.indexOf(' FROM')).split(',')});
  }
  if(JSON.stringify(fences).length>512*1024)return null;
  return{fences,capturedAt:Date.now()};
 }catch{return null;}
}
export function profileRecoverySnapshotGuards(db:D1Database,snapshot:ProfileRecoverySnapshot,id:string):D1PreparedStatement[]{
 return snapshot.fences.map(f=>{
  const rows=JSON.stringify(f.rows),match=f.columns.map(col=>`a.${col} COLLATE BINARY IS json_extract(e.value,'$.${col}') COLLATE BINARY`).join(' AND ');
  const sql=`INSERT INTO project_alpha_directory_profile_recovery_guards(id,ok) VALUES(?,CASE WHEN
   (SELECT count(*) FROM (${f.sql}))=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM (${f.sql}) a
   WHERE NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE ${match})) THEN 1 ELSE 0 END)
   ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`;
  return db.prepare(sql).bind(id,...f.values,rows,...f.values,rows);
 });
}
export function sameProfileRecoverySnapshot(a:ProfileRecoverySnapshot,b:ProfileRecoverySnapshot):boolean{
 return JSON.stringify(a.fences)===JSON.stringify(b.fences);
}
