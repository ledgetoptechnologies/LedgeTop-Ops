import { resolveProjectAlphaApiV2Connection,probeConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";
type IdentityEnvironment=Pick<Env,"OPS_DB"|"PROJECT_ALPHA_API_V2_CONNECTIONS">;

export function configuredLocalDivisionIdentity(env:IdentityEnvironment,sourceId:string):string|null {
  try {
    const selected=resolveProjectAlphaApiV2Connection(env,sourceId);
    if(!selected.enabled || !selected.connection.expectedHistoryEpoch)return null;
    const c=selected.connection;
    return JSON.stringify([c.baseUrl,c.expectedSourceInstanceId,c.expectedApplicationId,c.expectedHistoryEpoch]);
  } catch { return null; }
}
/** Runs under the source projection lease, before any new rows are written.
 * Clear first, including on a failed/disabled/missing probe. Never restamp maps.
 * The snapshot and capabilities must use the same normalized configured origin.
 */
export async function refreshLocalDivisionSourceIdentity(env:IdentityEnvironment,sourceId:string,snapshotUrl:string,
  fence:()=>D1PreparedStatement[] = ()=>[]):Promise<void> {
  if(!await d1TablesPresent(env.OPS_DB,["pa_local_division_source_heads"]))return;
  await env.OPS_DB.batch([...fence(),env.OPS_DB.prepare(`INSERT INTO pa_local_division_source_heads(projection_source_id,identity_key,revision,verified_at)
    VALUES(?,NULL,1,NULL) ON CONFLICT(projection_source_id) DO UPDATE SET identity_key=NULL,revision=revision+1,verified_at=NULL`).bind(sourceId)]);
  const revision=await env.OPS_DB.withSession("first-primary").prepare("SELECT revision FROM pa_local_division_source_heads WHERE projection_source_id=?").bind(sourceId).first<number>("revision");
  const key=configuredLocalDivisionIdentity(env,sourceId);
  if(!key)return;
  let origin:string;
  try {
    const url=new URL(snapshotUrl);
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/")return;
    origin=url.origin;
  } catch {return;}
  if(JSON.parse(key)[0]!==origin)return;
  const probe=await probeConfiguredProjectAlphaApiV2Connection(env,sourceId);
  if(probe.status!=="verified" || JSON.stringify([origin,probe.sourceInstanceId,probe.applicationId,probe.historyEpoch])!==key)return;
  await env.OPS_DB.batch([...fence(),env.OPS_DB.prepare(`UPDATE pa_local_division_source_heads SET identity_key=?,verified_at=datetime('now')
    WHERE projection_source_id=? AND revision=? AND identity_key IS NULL`).bind(key,sourceId,revision)]);
}
