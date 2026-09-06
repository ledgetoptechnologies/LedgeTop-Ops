export type NativeWorkspaceFeatureKey =
  | 'directory'
  | 'deliveries'
  | 'serviceRequests'
  | 'feedback'
  | 'models'
  | 'team'
  | 'billing';

export type NativeWorkspaceFeatureState =
  | 'available'
  | 'not_in_access'
  | 'not_supported'
  | 'temporarily_unavailable';

export type NativeWorkspaceFeatureReason =
  | 'authorized_capability'
  | 'resource_authorization_required'
  | 'capability_not_granted'
  | 'source_not_supported'
  | 'backend_unavailable';

export interface NativeWorkspaceFeatureStatus {
  state: NativeWorkspaceFeatureState;
  reason: NativeWorkspaceFeatureReason;
}

export type NativeWorkspaceFeatureReadiness = Record<NativeWorkspaceFeatureKey, NativeWorkspaceFeatureStatus>;

type TimedNativeGrant = NativePortalReadContext['grants'][number] & { valid_from?:unknown; expires_at?:unknown };
const directoryScopeTypes = new Set<PortalWorkspaceTarget['scopeType']>([
  'organization','standalone_client','department','client','project','contact',
]);
function grantTime(value:unknown):number|null {
  if(typeof value!=='string'||value.length<10||value.length>40)return null;
  const normalized=/[zZ]$|[+-]\d\d:\d\d$/.test(value)?value:`${value.replace(' ','T')}Z`;
  const timestamp=Date.parse(normalized);return Number.isFinite(timestamp)?timestamp:null;
}
function effectiveGrants(context:NativePortalReadContext,now:number):NativePortalReadContext['grants'] {
  return context.grants.filter(raw=>{
    const grant=raw as TimedNativeGrant;
    if(grant.valid_from!==undefined){const from=grantTime(grant.valid_from);if(from===null||from>now)return false;}
    if(grant.expires_at!==undefined&&grant.expires_at!==null){const expires=grantTime(grant.expires_at);if(expires===null||expires<=now)return false;}
    return true;
  });
}
function directoryTargets(context:NativePortalReadContext,now:number):PortalWorkspaceTarget[] {
  const targets=new Map<string,PortalWorkspaceTarget>();
  for(const grant of effectiveGrants(context,now)){
    if(grant.capability!=='directory.read'||grant.effect!=='allow')continue;
    const target:PortalWorkspaceTarget|undefined=grant.scope_type==='workspace'
      ?{scopeType:context.rootType,publicId:context.rootPublicId}
      :directoryScopeTypes.has(grant.scope_type)?{scopeType:grant.scope_type,publicId:grant.scope_public_id}:undefined;
    if(target)targets.set(`${target.scopeType}:${target.publicId}`,target);
  }
  return [...targets.values()];
}

/** Prove that at least one current directory target is effectively readable.
 * An allow row alone is insufficient: exact lineage, entitlement deny precedence
 * and identity denials are evaluated by the same function as the resource read. */
export function nativeDirectoryAuthorizationFromProofs(context:NativePortalReadContext,
  proofs:ReadonlyMap<string,NativeTargetScopes>,now=Date.now()):boolean {
  const current={...context,grants:effectiveGrants(context,now)};
  return directoryTargets(current,now).some(target=>{
    const proof=proofs.get(`${target.scopeType}:${target.publicId}`);
    return Boolean(proof&&nativePortalScopesAllowed(current,'directory.read',proof.scopes,true,proof));
  });
}

export async function nativeDirectoryAuthorizationAvailable(env:Pick<Env,'DELIVERY_DB'|'CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED'>,
  context:NativePortalReadContext):Promise<boolean> {
  const now=Date.now(),targets=directoryTargets(context,now);
  if(!targets.length)return false;
  const proofs=await readNativeTargetScopes(env,context,targets,{retention:'structural'});
  return nativeDirectoryAuthorizationFromProofs(context,proofs,now);
}

/**
 * Reports what the native workspace can operate right now. This is deliberately
 * not a purchased-service or service-assignment model. Resource endpoints still
 * perform their own current, target-specific authorization checks.
 */
export function nativeWorkspaceFeatureReadiness(input: {
  directoryAuthorized: boolean;
  deliveryBackendReady: boolean;
  feedbackBackendReady?: boolean;
  serviceRequestsReady?: boolean;
  viewerBackendReady?: boolean;
}): NativeWorkspaceFeatureReadiness {
  const unsupported: NativeWorkspaceFeatureStatus = { state: 'not_supported', reason: 'source_not_supported' };
  return {
    directory: input.directoryAuthorized
      ? { state: 'available', reason: 'authorized_capability' }
      : { state: 'not_in_access', reason: 'capability_not_granted' },
    deliveries: input.deliveryBackendReady
      ? { state: 'available', reason: 'resource_authorization_required' }
      : { state: 'temporarily_unavailable', reason: 'backend_unavailable' },
    serviceRequests: input.serviceRequestsReady
      ? { state: 'available', reason: 'resource_authorization_required' }
      : { ...unsupported },
    feedback: input.feedbackBackendReady && input.directoryAuthorized
      ? { state: 'available', reason: 'resource_authorization_required' }
      : input.feedbackBackendReady
        ? { state: 'not_in_access', reason: 'capability_not_granted' }
        : { state: 'temporarily_unavailable', reason: 'backend_unavailable' },
    models: input.viewerBackendReady
      ? { state: 'available', reason: 'resource_authorization_required' }
      : { ...unsupported },
    team: { ...unsupported },
    billing: { ...unsupported },
  };
}
import type { Env } from '../types';
import { readNativeTargetScopes, type NativeTargetScopes } from './native-portal-scopes';
import { nativePortalScopesAllowed, type NativePortalReadContext, type PortalWorkspaceTarget } from './workspace-v2';
