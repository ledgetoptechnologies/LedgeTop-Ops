import { projectAccessTermsSql } from './project-access-terms';

/** Internal SQL only. Expired explicit allows are history, not current policy
 * capacity. Preserve every deny and every unclassified rule; target ancestry
 * and the existing current-rule limit are still checked by each reader. */
export function projectAccessCapacitySql(alias:string,ready:boolean):string {
  if(!/^[a-z_][a-z0-9_]*$/.test(alias))throw new Error('Invalid internal terms alias');
  if(!ready)return '1';
  return `(${alias}.effect='deny' OR ${projectAccessTermsSql({
    termsId:`${alias}.access_terms_id`,workspaceId:`${alias}.workspace_id`,
    projectId:`(SELECT project_public_id FROM portal_project_access_terms WHERE id=${alias}.access_terms_id)`,
    legacyRetained:'1',
  })})`;
}
