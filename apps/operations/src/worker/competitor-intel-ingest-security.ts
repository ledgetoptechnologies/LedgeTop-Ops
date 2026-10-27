import { IntelIngestError,timestamp } from './competitor-intel-ingest-schema';
export const INTEL_INGEST_PATH='/api/competitor-intel/ingest/v1/observations';
export const INTEL_BODY_LIMIT=256*1024;
const encode=new TextEncoder();
export function base64url(bytes:Uint8Array):string {let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');}
export function decodeBase64url(value:string,length:number):Uint8Array|null {try{if(!/^[A-Za-z0-9_-]+$/.test(value))return null;const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));return bytes.length===length&&base64url(bytes)===value?bytes:null;}catch{return null;}}
export async function intelDigest(bytes:Uint8Array):Promise<string>{return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)));}
export type ProducerKey={producer_id:string;key_id:string;public_key:string;key_revision:number;state:'active'|'previous'|'retired'|'revoked'};
export type IntelSignature={producer:string;keyId:string;timestamp:string;digest:string;signature:Uint8Array};
export function intelSignatureHeaders(request:Request,now:number):IntelSignature {
 const producer=request.headers.get('X-CI-Producer')??'',keyId=request.headers.get('X-CI-Key-Id')??'',ts=request.headers.get('X-CI-Timestamp')??'',digest=request.headers.get('X-CI-Content-SHA256')??'';
 const signature=decodeBase64url(request.headers.get('X-CI-Signature')??'',64);
 if(request.method!=='POST'||new URL(request.url).pathname!==INTEL_INGEST_PATH||request.url.includes('?')
 ||!(/^[a-z0-9-]{3,64}$/).test(producer)||!(/^[a-z0-9-]{3,64}$/).test(keyId)||!timestamp.safeParse(ts).success||!decodeBase64url(digest,32)||!signature)throw new IntelIngestError('header_invalid',400);
 if(Math.abs(now-Date.parse(ts))>300_000)throw new IntelIngestError('timestamp_out_of_window',401);
 return {producer,keyId,timestamp:ts,digest,signature};
}
export function intelSigningBytes(headers:Pick<IntelSignature,'producer'|'keyId'|'timestamp'|'digest'>):Uint8Array {
 return encode.encode(['ltci-observation-sig-v1','POST',INTEL_INGEST_PATH,headers.producer,headers.keyId,headers.timestamp,headers.digest].join('\n'));
}
export async function verifyIntelSignature(raw:Uint8Array,headers:IntelSignature,key:ProducerKey):Promise<void> {
 if(key.producer_id!==headers.producer||key.key_id!==headers.keyId)throw new IntelIngestError('producer_not_allowed',403);
 if(!['active','previous'].includes(key.state))throw new IntelIngestError('key_not_active',403);
 const publicKey=decodeBase64url(key.public_key,32);
 if(!publicKey||!Number.isSafeInteger(key.key_revision)||key.key_revision<1)throw new IntelIngestError('retryable',503);
 if(await intelDigest(raw)!==headers.digest)throw new IntelIngestError('digest_mismatch',401);
 let valid=false;try{const imported=await crypto.subtle.importKey('raw',publicKey as BufferSource,{name:'Ed25519'},false,['verify']);valid=await crypto.subtle.verify('Ed25519',imported,headers.signature as BufferSource,intelSigningBytes(headers) as BufferSource);}catch{throw new IntelIngestError('signature_invalid',401);}
 if(!valid)throw new IntelIngestError('signature_invalid',401);
}
export async function readIntelBody(request:{headers:Headers;body:ReadableStream<Uint8Array>|null}):Promise<Uint8Array> {
 const declared=request.headers.get('Content-Length');
 if(declared!==null&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))))throw new IntelIngestError('header_invalid',400);
 if(declared!==null&&Number(declared)>INTEL_BODY_LIMIT)throw new IntelIngestError('body_too_large',413);
 const reader=request.body?.getReader();if(!reader)throw new IntelIngestError('schema_invalid',400);
 let length=0;const chunks:Uint8Array[]=[];
 try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>INTEL_BODY_LIMIT){await reader.cancel();throw new IntelIngestError('body_too_large',413);}chunks.push(next.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
