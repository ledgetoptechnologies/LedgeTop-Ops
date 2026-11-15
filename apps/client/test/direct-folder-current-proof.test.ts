import {describe,expect,it} from 'vitest';
import {currentDirectFolderAuthorityAllowed} from '../src/worker/client-portal/direct-folder-current-proof';
import {hashDirectClientFolderReadRequest,type DirectClientFolderReadRequest} from '@ltds/shared/direct-client-folder-read-authority';
import type {Env} from '../src/worker/types';

const coordinate={grantId:'11111111-1111-4111-8111-111111111111',grantVersion:1,workspaceId:'workspace:one',
  targetId:'22222222-2222-4222-8222-222222222222',clientAuthorityId:'33333333-3333-4333-8333-333333333333',
  sourceId:'project-alpha:primary' as const,recipientRecordId:'selected-client',issuer:'https://access.example.test',subject:'subject-one',folderRef:'Sm9icy9DbGllbnRzL1Rlc3Q'};
const publication={targetRevision:1,publicationRevision:2,snapshotId:'snapshot-two',snapshotSha256:'a'.repeat(64)};
const recipient={recordId:'selected-client',version:3,relationshipVersion:1};
function environment(call:(request:DirectClientFolderReadRequest)=>Promise<string>){
  return {OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER:{readDirectFolderAuthorization:call}} as
    Pick<Env,'OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER'>;
}
async function reply(request:DirectClientFolderReadRequest,change:Record<string,unknown>={}){
  return JSON.stringify({ok:true,protocolVersion:1,requestId:request.requestId,requestSha256:await hashDirectClientFolderReadRequest(request),
    observedAt:new Date().toISOString(),authorization:{...coordinate,...publication,currentRecipientRecordId:recipient.recordId,
      currentRecipientProfileVersion:recipient.version,currentRecipientRelationshipVersion:recipient.relationshipVersion,
      issuer:undefined,subject:undefined,...change}});
}
describe('current direct-folder private authority proof',()=>{
  it('accepts the exact nonce, current publication and selected profile, using a fresh nonce each time',async()=>{
    const requests:DirectClientFolderReadRequest[]=[];
    const env=environment(async request=>{requests.push(request);return reply(request);});
    await expect(currentDirectFolderAuthorityAllowed(env,coordinate,publication,recipient)).resolves.toBe(true);
    await expect(currentDirectFolderAuthorityAllowed(env,coordinate,publication,recipient)).resolves.toBe(true);
    expect(requests).toHaveLength(2);expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
  });
  for(const change of [{currentRecipientRecordId:'sibling-client'},{snapshotSha256:'b'.repeat(64)},{grantVersion:2}])
    it(`rejects a mismatched proof: ${JSON.stringify(change)}`,async()=>{
      await expect(currentDirectFolderAuthorityAllowed(environment(request=>reply(request,change)),coordinate,publication,recipient))
        .rejects.toThrow('mismatch');
    });
  it('rejects a replayed response to a new nonce',async()=>{
    let wire:string|undefined;
    const env=environment(async request=>wire??=await reply(request));
    await expect(currentDirectFolderAuthorityAllowed(env,coordinate,publication,recipient)).resolves.toBe(true);
    await expect(currentDirectFolderAuthorityAllowed(env,coordinate,publication,recipient)).rejects.toThrow('mismatch');
  });
  it('keeps denied and unavailable distinct',async()=>{
    await expect(currentDirectFolderAuthorityAllowed(environment(async()=>JSON.stringify({ok:false,protocolVersion:1,code:'denied'})),coordinate,publication,recipient)).resolves.toBe(false);
    await expect(currentDirectFolderAuthorityAllowed(environment(async()=>JSON.stringify({ok:false,protocolVersion:1,code:'unavailable'})),coordinate,publication,recipient)).rejects.toThrow('unavailable');
  });
  it('requires the private method and rejects malformed wire responses',async()=>{
    await expect(currentDirectFolderAuthorityAllowed({},coordinate,publication,recipient)).rejects.toThrow('unavailable');
    await expect(currentDirectFolderAuthorityAllowed(environment(async()=>'{"ok":true}'),coordinate,publication,recipient)).rejects.toThrow('invalid');
  });
});
