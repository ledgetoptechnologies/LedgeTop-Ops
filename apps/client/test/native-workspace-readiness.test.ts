import { describe, expect, it } from 'vitest';
import { nativeDirectoryAuthorizationFromProofs, nativeWorkspaceFeatureReadiness } from '../src/worker/client-portal/native-workspace-readiness';
import type { NativePortalReadContext } from '../src/worker/client-portal/workspace-v2';
import type { NativeTargetScopes } from '../src/worker/client-portal/native-portal-scopes';

function context(grants:NativePortalReadContext['grants']):NativePortalReadContext {
  const value={workspaceId:'workspace-a',sourceId:'project-alpha:secondary',identityId:'identity-a',displayName:'Workspace A',
    rootType:'organization',rootPublicId:'organization-a',generationId:'generation-a',contextVersion:'context-a',grants,denials:[]};
  return value as unknown as NativePortalReadContext;
}
function proof(targetType:'organization'|'project',targetId:string):NativeTargetScopes {
  const rows=[{target_type:targetType,target_id:targetId,entity_type:targetType,public_id:targetId,parent_public_id:targetType==='project'?'organization-a':null,
    source_version:'v1',depth:0,display_name:'Target',binding_version:null,retained:1},
    ...(targetType==='project'?[{target_type:targetType,target_id:targetId,entity_type:'organization',public_id:'organization-a',parent_public_id:null,
      source_version:'v1',depth:1,display_name:'Target',binding_version:null,retained:1}]:[])];
  return {scopes:new Set([`workspace:workspace-a`,`organization:organization-a`,`${targetType}:${targetId}`]),versions:new Map(),name:'Target',bindingVersion:null,
    proofRows:rows};
}
function grant(effect:'allow'|'deny',scope_type:'workspace'|'project',scope_public_id:string,expires_at:string|null=null){
  return {capability:'directory.read' as const,effect,scope_type,scope_public_id,source_type:'project_alpha',valid_from:'2026-01-01 00:00:00',expires_at};
}

describe('native workspace feature readiness', () => {
  it('reports only current operational surfaces and never fabricates secondary write capabilities', () => {
    expect(nativeWorkspaceFeatureReadiness({ directoryAuthorized: true, deliveryBackendReady: true })).toEqual({
      directory: { state: 'available', reason: 'authorized_capability' },
      deliveries: { state: 'available', reason: 'resource_authorization_required' },
      serviceRequests: { state: 'not_supported', reason: 'source_not_supported' },
      feedback: { state: 'not_supported', reason: 'source_not_supported' },
      models: { state: 'not_supported', reason: 'source_not_supported' },
      team: { state: 'not_supported', reason: 'source_not_supported' },
      billing: { state: 'not_supported', reason: 'source_not_supported' },
    });
  });

  it('distinguishes missing authorization from an unavailable delivery backend', () => {
    const readiness = nativeWorkspaceFeatureReadiness({ directoryAuthorized: false, deliveryBackendReady: false });
    expect(readiness.directory).toEqual({ state: 'not_in_access', reason: 'capability_not_granted' });
    expect(readiness.deliveries).toEqual({ state: 'temporarily_unavailable', reason: 'backend_unavailable' });
    expect(readiness.serviceRequests.state).toBe('not_supported');
  });

  it('does not claim directory access when a workspace deny overrides an allow', () => {
    const current=context([grant('allow','workspace','workspace-a'),grant('deny','workspace','workspace-a')]);
    expect(nativeDirectoryAuthorizationFromProofs(current,new Map([['organization:organization-a',proof('organization','organization-a')]]),Date.parse('2026-08-26T12:00:00Z'))).toBe(false);
  });

  it('does not claim directory access from an expired-only allow', () => {
    const expired=context([grant('allow','workspace','workspace-a','2026-08-25 00:00:00')]);
    expect(nativeDirectoryAuthorizationFromProofs(expired,new Map([['organization:organization-a',proof('organization','organization-a')]]),Date.parse('2026-08-26T12:00:00Z'))).toBe(false);
  });

  it('keeps an effectively authorized project-only workspace discoverable', () => {
    const projectOnly=context([grant('allow','project','project-a')]);
    expect(nativeDirectoryAuthorizationFromProofs(projectOnly,new Map([['project:project-a',proof('project','project-a')]]),Date.parse('2026-08-26T12:00:00Z'))).toBe(true);
  });
});
