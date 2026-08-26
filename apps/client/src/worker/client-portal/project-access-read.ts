import { projectAccessTermsSql } from './project-access-terms';

/** Internal authorization facts, never a customer classification for a person. */
export interface ProjectAccessReadRow {
  access_terms_id?: string | null;
  terms_project_id?: string | null;
  terms_live?: number;
  terms_kind?: 'customer'|'collaborator'|null;
}

export function projectAccessReadColumns(alias:string,ready:boolean):string {
  if(!/^[a-z_][a-z0-9_]*$/.test(alias))throw new Error('Invalid internal terms alias');
  if(!ready)return 'NULL access_terms_id,NULL terms_project_id,NULL terms_kind,1 terms_live';
  const project=`(SELECT project_public_id FROM portal_project_access_terms WHERE id=${alias}.access_terms_id)`;
  return `${alias}.access_terms_id,${project} terms_project_id,
    (SELECT kind FROM portal_project_access_terms WHERE id=${alias}.access_terms_id) terms_kind,CASE WHEN ${projectAccessTermsSql({
    termsId:`${alias}.access_terms_id`,workspaceId:`${alias}.workspace_id`,projectId:project,legacyRetained:'1',
  })} THEN 1 ELSE 0 END terms_live`;
}

/** Terms restrict this allow alone. They never remove a deny or another allow.
 * A shell allow may refer to its own project without exposing that project's
 * data. Every resource allow must intersect the exact project in its ancestry. */
export function projectAccessRowAllows(row:ProjectAccessReadRow,scopes:ReadonlySet<string>,
  expiredProjects:readonly string[]=[],shell=false):boolean {
  if(!row.access_terms_id)return expiredProjects.length===0;
  return row.terms_live===1&&typeof row.terms_project_id==='string'
    &&(shell||scopes.has(`project:${row.terms_project_id}`))
    &&expiredProjects.every(id=>id===row.terms_project_id);
}

export async function readExpiredScopeProjects(db:Pick<D1Database,'prepare'>,workspaceId:string,
  scopes:ReadonlySet<string>,relations:boolean):Promise<string[]> {
  const ids=[...scopes].filter(scope=>scope.startsWith('project:')).map(scope=>scope.slice(8));
  if(!relations||!ids.length)return [];
  const rows=await db.prepare(`SELECT requested.value id FROM json_each(?) requested
    WHERE NOT EXISTS(SELECT 1 FROM portal_v2_directory_checkpoints cp JOIN portal_v2_project_lifecycle l
      ON l.workspace_id=cp.workspace_id AND l.generation_id=cp.active_generation_id
      WHERE cp.workspace_id=? AND l.project_public_id=requested.value
        AND (l.lifecycle_status='active' OR datetime(l.completed_at,'+30 days')>datetime('now')))`)
    .bind(JSON.stringify(ids),workspaceId).all<{id:string}>();
  return rows.results.map(row=>row.id);
}
