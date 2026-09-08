import { z } from 'zod';
import type { Env } from '../types';

const MAX_TTL_MS=60*60_000;
const CLOCK_SKEW_MS=5*60_000;
const SOURCE_ID=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const OPAQUE=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const control=/[\u0000-\u001f\u007f]/;

function safeText(value:string,maximum:number):boolean {
  return value.length>0&&value.length<=maximum&&!control.test(value);
}

/** Handles are route inputs, not storage keys. A folder path may be empty,
 * while all non-root folder paths use one canonical trailing slash. */
function canonicalPath(value:string,directory:boolean):boolean {
  if(value.length>2048||value!==value.normalize('NFC')||value.startsWith('/')||value.includes('\\')||control.test(value))return false;
  if(directory){
    if(value==='')return true;
    if(!value.endsWith('/'))return false;
    value=value.slice(0,-1);
  }else if(value===''||value.endsWith('/'))return false;
  return value.split('/').every(part=>part.length>0&&part.length<=255&&part!=='.'&&part!=='..');
}

const common={
  v:z.literal(1),
  sourceId:z.string().regex(SOURCE_ID),
  workspaceId:z.string().regex(OPAQUE),
  // This is the portal-v2 global identity, never the legacy adapter identity.
  identityId:z.string().refine(value=>safeText(value,200)),
  eventId:z.string().regex(OPAQUE),
  grantId:z.string().refine(value=>safeText(value,200)),
  grantVersion:z.number().int().positive(),
  bindingId:z.string().regex(OPAQUE),
  bindingSourceVersion:z.string().refine(value=>safeText(value,512)),
  expires:z.number().int().positive(),
};

const folder=z.object({...common,kind:z.literal('folder'),path:z.string().refine(value=>canonicalPath(value,true))}).strict();
const file=z.object({...common,kind:z.literal('file'),path:z.string().refine(value=>canonicalPath(value,false)),
  etag:z.string().refine(value=>safeText(value,256))}).strict();
const cursor=z.object({...common,kind:z.literal('cursor'),path:z.string().refine(value=>canonicalPath(value,true)),
  after:z.string().refine(value=>safeText(value,1024)&&!value.includes('/')&&!value.includes('\\')&&value===value.normalize('NFC')),
  entryKind:z.enum(['file','folder'])}).strict();
const handle=z.discriminatedUnion('kind',[folder,file,cursor]);

/**
 * Encrypted, short-lived, exact authenticated-delivery resource coordinate.
 * The resource router must additionally prove the current recipient event,
 * global identity, workspace, grant, binding, and policy authority; decoding
 * this token alone never authorizes a read. It intentionally carries no R2
 * prefix or owner metadata.
 */
export type AuthenticatedDeliveryHandle=z.infer<typeof handle>;
type KeyEnv=Pick<Env,'DELIVERY_SESSION_SECRET'|'DELIVERY_PREVIOUS_SESSION_SECRET'>;

function base64(bytes:Uint8Array):string {let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function key(secret:string):Promise<CryptoKey>{
  if(secret.length<32)throw new Error('authenticated-delivery-handles-unavailable');
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`authenticated-delivery-resource-v1\0${secret}`)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}

/** Encodes only a handle expiring within one hour of issuance. */
export async function encodeAuthenticatedDeliveryHandle(env:KeyEnv,value:AuthenticatedDeliveryHandle):Promise<string>{
  const parsed=handle.parse(value),now=Date.now();
  if(parsed.expires<=now||parsed.expires>now+MAX_TTL_MS)throw new Error('authenticated-delivery-handle-expiry-invalid');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env.DELIVERY_SESSION_SECRET??''),new TextEncoder().encode(JSON.stringify(parsed))));
  const bytes=new Uint8Array(iv.length+encrypted.length);bytes.set(iv);bytes.set(encrypted,iv.length);
  const encoded=`ad1_${base64(bytes)}`;
  if(encoded.length>8192)throw new Error('authenticated-delivery-handle-too-large');
  return encoded;
}

/** Decodes a current or rotating-previous-key AD1 resource coordinate. */
export async function decodeAuthenticatedDeliveryHandle(env:KeyEnv,value:string):Promise<AuthenticatedDeliveryHandle|null>{
  if(value.length>8192||!/^ad1_[A-Za-z0-9_-]+$/.test(value))return null;
  const raw=value.slice(4);let bytes:Uint8Array;
  try{bytes=Uint8Array.from(atob(raw.replace(/-/g,'+').replace(/_/g,'/')),character=>character.charCodeAt(0));if(base64(bytes)!==raw||bytes.length<29)return null;}catch{return null;}
  for(const secret of [env.DELIVERY_SESSION_SECRET,env.DELIVERY_PREVIOUS_SESSION_SECRET]){
    if(!secret||secret.length<32)continue;
    try{
      const parsed=handle.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt(
        {name:'AES-GCM',iv:bytes.slice(0,12)},await key(secret),bytes.slice(12)))));
      const now=Date.now();
      if(parsed.expires<=now||parsed.expires>now+MAX_TTL_MS+CLOCK_SKEW_MS)return null;
      return parsed;
    }catch{/* A different key, malformed payload, or tampering is never accepted. */}
  }
  return null;
}
