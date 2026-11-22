import {DIRECT_CLIENT_FOLDER_READ_MAX_BYTES,hashDirectClientFolderReadRequest,parseDirectClientFolderReadResult,
  type DirectClientFolderReadRequest} from '@ltds/shared/direct-client-folder-read-authority';
import type {Env} from '../types';

type ProofEnv=Pick<Env,'OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER'>;
type Coordinate=Omit<DirectClientFolderReadRequest,'protocolVersion'|'requestId'>;
type Publication={targetRevision:number;publicationRevision:number;snapshotId:string;snapshotSha256:string};
type Recipient={recordId:string;version:number;relationshipVersion:number|null};

/** No authority is cached across requests or asynchronous content reads.
 * Timeout bounds observation of a read-only RPC, not cancellation upstream. */
export async function currentDirectFolderAuthorityAllowed(env:ProofEnv,coordinate:Coordinate,publication:Publication,recipient:Recipient):Promise<boolean>{
  const binding=env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER;
  if(typeof binding?.readDirectFolderAuthorization!=='function')throw new Error('direct-folder-current-authority-unavailable');
  const request:DirectClientFolderReadRequest={...coordinate,protocolVersion:1,requestId:crypto.randomUUID()};
  const hash=await hashDirectClientFolderReadRequest(request),started=Date.now();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const wire=await Promise.race([binding.readDirectFolderAuthorization(request),new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('direct-folder-current-authority-timeout')),1500);
    })]);
    if(typeof wire!=='string'||wire.length>DIRECT_CLIENT_FOLDER_READ_MAX_BYTES)throw new Error('direct-folder-current-authority-invalid');
    const result=parseDirectClientFolderReadResult(wire);
    if(!result)throw new Error('direct-folder-current-authority-invalid');
    if(!result.ok){if(result.code==='denied')return false;throw new Error('direct-folder-current-authority-unavailable');}
    const observed=Date.parse(result.observedAt),authorization=result.authorization;
    if(result.requestId!==request.requestId||result.requestSha256!==hash||observed<started-2000||observed>Date.now()+2000
      ||Date.now()-started>5000||authorization.workspaceId!==request.workspaceId||authorization.targetId!==request.targetId
      ||authorization.clientAuthorityId!==request.clientAuthorityId||authorization.sourceId!==request.sourceId
      ||authorization.recipientRecordId!==request.recipientRecordId||authorization.grantId!==request.grantId
      ||authorization.grantVersion!==request.grantVersion||authorization.folderRef!==request.folderRef
      ||authorization.targetRevision!==publication.targetRevision||authorization.publicationRevision!==publication.publicationRevision
      ||authorization.snapshotId!==publication.snapshotId||authorization.snapshotSha256!==publication.snapshotSha256
      ||authorization.currentRecipientRecordId!==recipient.recordId||authorization.currentRecipientProfileVersion!==recipient.version
      ||authorization.currentRecipientRelationshipVersion!==recipient.relationshipVersion)
      throw new Error('direct-folder-current-authority-mismatch');
    return true;
  }finally{if(timer!==undefined)clearTimeout(timer);}
}
