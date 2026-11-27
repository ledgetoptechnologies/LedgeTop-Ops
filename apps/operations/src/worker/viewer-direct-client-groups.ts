import type {Env,StaffPrincipal} from './types';
import {requireDirectViewerClientManage} from './viewer-direct-client-grants';
import {clientHubActiveDirectoryIdentities,clientHubActiveDirectoryIdentitySql} from './client-hub-source';

/** Which portal workspaces belong to one real client, for the Viewer Share picker only.
 * The only link used is an owner-reviewed shared directory profile: never a name, email or
 * public ID on its own. Grouping changes presentation only; it grants nothing and every share
 * is still written to, and checked against, one exact workspace. Anything unclear (missing or
 * extra members, a record mapped twice in one source, a workspace matched twice) leaves those
 * workspaces ungrouped, which is how the picker has always shown them. */
export const DIRECT_VIEWER_CLIENT_GROUP_LIMIT=250;
const GROUP_MEMBER_LIMIT=4;
/** Optional lookup: answer without groups rather than hold the Share dialog. */
export const DIRECT_VIEWER_CLIENT_GROUP_DEADLINE_MS=1500;
export type DirectViewerClientGroup=Array<[sourceId:string,workspaceId:string]>;
export type DirectViewerClientGroups={groups:DirectViewerClientGroup[]};

type MappingRow={group_id:string;record_id:string;source_id:string;resource_type:'organization'|'client';project_alpha_public_id:string};
type WorkspaceRow={id:string;project_alpha_source_id:string;root_type:'organization'|'standalone_client';root_public_id:string};

// Two-member reviewed groups whose stored membership matches their member rows exactly, mapped only through each
// source's current instance, application and history epoch, where record and public ID correspond one to one
// (the same rule as Client Hub's active directory reads). One pass over the current mappings; members by key.
const mappingSql=(current:string)=>`WITH current_mapping AS (SELECT mapping.record_id,mapping.source_id,mapping.resource_type,
  mapping.project_alpha_public_id,
  count(*) OVER (PARTITION BY mapping.source_id,mapping.resource_type,mapping.record_id) per_record,
  count(*) OVER (PARTITION BY mapping.source_id,mapping.resource_type,mapping.external_id) per_external,
  count(*) OVER (PARTITION BY mapping.source_id,mapping.resource_type,mapping.project_alpha_public_id) per_public_id
 FROM project_alpha_active_directory_mappings mapping WHERE ${current})
 SELECT member.group_id,member.record_id,mapping.source_id,mapping.resource_type,mapping.project_alpha_public_id
 FROM current_mapping mapping
 CROSS JOIN native_directory_shared_profile_members member ON member.record_id=mapping.record_id
 JOIN native_directory_shared_profiles profile ON profile.id=member.group_id AND profile.kind=mapping.resource_type
 WHERE mapping.per_record=1 AND mapping.per_external=1 AND mapping.per_public_id=1
  AND json_array_length(profile.membership_json)=2
  AND (SELECT count(*) FROM native_directory_shared_profile_members actual WHERE actual.group_id=profile.id)=2
  AND (SELECT count(*) FROM json_each(profile.membership_json) listed
   JOIN native_directory_shared_profile_members actual ON actual.group_id=profile.id AND actual.record_id=listed.value)=2
  AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state WHERE state.record_id=member.record_id AND state.status<>'active')
 ORDER BY member.group_id,member.record_id,mapping.source_id LIMIT ?`;
// Active, current-account workspaces whose root is exactly one of the mapped records (root ID columns kept bare for their indexes).
const WORKSPACE_SQL=`SELECT w.id,w.project_alpha_source_id,w.root_type,COALESCE(w.pa_organization_public_id,w.pa_client_public_id) root_public_id
 FROM json_each(?) wanted JOIN portal_v2_workspaces w
  ON w.project_alpha_source_id=json_extract(wanted.value,'$[0]') AND w.root_type=json_extract(wanted.value,'$[1]')
  AND ((json_extract(wanted.value,'$[1]')='organization' AND w.pa_organization_public_id=json_extract(wanted.value,'$[2]'))
   OR (json_extract(wanted.value,'$[1]')='standalone_client' AND w.pa_client_public_id=json_extract(wanted.value,'$[2]')))
 WHERE w.status='active' AND w.legacy_account_id IS NULL`;
/** Kept well under the Viewer's 128 KiB limit even with long IDs. */
export const DIRECT_VIEWER_CLIENT_GROUP_BYTES=96*1024;

const rootType=(kind:MappingRow['resource_type'])=>kind==='organization'?'organization':'standalone_client';
const tupleKey=(sourceId:string,root:string,publicId:string)=>JSON.stringify([sourceId,root,publicId]);

async function readGroups(env:Env,rowLimit:number):Promise<DirectViewerClientGroups>{
 // Only sources whose deployed connection names a current instance, application and epoch can link anything.
 const identities=await clientHubActiveDirectoryIdentities(env);
 if(!identities?.length)return {groups:[]};
 // Two-member groups each map to a few rows; one extra row shows the list was cut.
 const mapped=(await env.OPS_DB.withSession('first-primary').prepare(mappingSql(clientHubActiveDirectoryIdentitySql('mapping',identities)))
  .bind(rowLimit+1).all<MappingRow>()).results;
 const rows=mapped.slice(0,rowLimit);
 // A group cut off at the limit is dropped, never shown with only part of its members.
 if(mapped.length>rowLimit){const last=rows.at(-1)?.group_id;while(rows.length&&rows.at(-1)!.group_id===last)rows.pop();}
 const byGroup=new Map<string,MappingRow[]>();
 for(const row of rows){if(!byGroup.has(row.group_id))byGroup.set(row.group_id,[]);byGroup.get(row.group_id)!.push(row);}
 // Each member may be in several sources, but in each source exactly one public ID.
 const usable=new Map<string,Array<{sourceId:string;root:string;publicId:string}>>();
 for(const [groupId,members] of byGroup){
  const perSource=new Map<string,Set<string>>();let clear=true;
  for(const row of members){const key=JSON.stringify([row.record_id,row.source_id]);
   if(!perSource.has(key))perSource.set(key,new Set());perSource.get(key)!.add(row.project_alpha_public_id);}
  for(const ids of perSource.values())if(ids.size!==1)clear=false;
  const sources=[...perSource.keys()].map(key=>JSON.parse(key)[1] as string);
  // A source holding both members would make two workspaces of one division look like one client.
  if(!clear||new Set(sources).size!==sources.length||sources.length<2||sources.length>GROUP_MEMBER_LIMIT)continue;
  const kind=members[0]!.resource_type;
  usable.set(groupId,[...perSource].map(([key,ids])=>({sourceId:JSON.parse(key)[1] as string,root:rootType(kind),publicId:[...ids][0]!})));
 }
 if(!usable.size)return {groups:[]};
 const wanted=[...new Map([...usable.values()].flat().map(item=>[tupleKey(item.sourceId,item.root,item.publicId),[item.sourceId,item.root,item.publicId]])).values()];
 const found=(await env.DELIVERY_DB.withSession('first-primary').prepare(WORKSPACE_SQL).bind(JSON.stringify(wanted)).all<WorkspaceRow>()).results;
 const workspaces=new Map<string,WorkspaceRow[]>();
 for(const row of found){const key=tupleKey(row.project_alpha_source_id,row.root_type,row.root_public_id);
  if(!workspaces.has(key))workspaces.set(key,[]);workspaces.get(key)!.push(row);}
 const groups:DirectViewerClientGroup[]=[],seen=new Map<string,number>();
 for(const members of usable.values()){
  const group:DirectViewerClientGroup=[];
  for(const item of members){const matches=workspaces.get(tupleKey(item.sourceId,item.root,item.publicId))??[];
   // Two active workspaces for one record cannot be told apart here: leave that member out.
   if(matches.length===1)group.push([matches[0]!.project_alpha_source_id,matches[0]!.id]);}
  if(group.length<2)continue;
  group.sort((left,right)=>left[0].localeCompare(right[0])||left[1].localeCompare(right[1]));
  groups.push(group);for(const [,workspaceId] of group)seen.set(workspaceId,(seen.get(workspaceId)??0)+1);
 }
 // A workspace in two groups would join two clients: drop every group that holds it.
 const kept:DirectViewerClientGroup[]=[];let bytes=12;
 for(const group of groups.filter(group=>group.every(([,workspaceId])=>seen.get(workspaceId)===1))){
  bytes+=JSON.stringify(group).length+1;
  if(kept.length>=DIRECT_VIEWER_CLIENT_GROUP_LIMIT||bytes>DIRECT_VIEWER_CLIENT_GROUP_BYTES)break;kept.push(group);
 }
 return {groups:kept};
}

/** Staff-only, read-only. Errors and slow reads answer with no groups: rows then stay separate. */
export async function listDirectViewerClientGroups(env:Env,principal:StaffPrincipal,
 {deadlineMs=DIRECT_VIEWER_CLIENT_GROUP_DEADLINE_MS,rowLimit=DIRECT_VIEWER_CLIENT_GROUP_LIMIT*GROUP_MEMBER_LIMIT}:{deadlineMs?:number;rowLimit?:number}={}):Promise<DirectViewerClientGroups>{
 await requireDirectViewerClientManage(env,principal);
 let timer:ReturnType<typeof setTimeout>|undefined;
 const late=new Promise<DirectViewerClientGroups>(resolve=>{timer=setTimeout(()=>resolve({groups:[]}),deadlineMs);});
 try{return await Promise.race([readGroups(env,rowLimit).catch(()=>({groups:[]})),late]);}
 finally{clearTimeout(timer);}
}
