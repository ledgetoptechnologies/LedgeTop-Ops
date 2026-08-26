import { z } from 'zod';
import type { Env } from '../types';

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const handle = z.object({
  v:z.literal(1),kind:z.enum(['folder','file','cursor']),sourceId:z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  workspaceId:opaque,identityId:z.string().min(1).max(200),contextVersion:z.string().regex(/^[a-f0-9]{64}$/),
  bindingId:z.string().max(128),bindingVersion:z.string().max(512),grantId:z.string().max(200),grantVersion:z.number().int().nonnegative(),
  bindingProof:z.string().regex(/^(?:[a-f0-9]{64})?$/),
  path:z.string().max(2048),etag:z.string().max(256).optional(),after:z.string().max(2048).optional(),entryKind:z.string().max(16).optional(),
  expires:z.number().int().positive(),
}).strict();
export type NativePortalHandle = z.infer<typeof handle>;
type KeyEnv = Pick<Env,'DELIVERY_SESSION_SECRET'|'DELIVERY_PREVIOUS_SESSION_SECRET'>;
function base64(bytes:Uint8Array):string {let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function key(secret:string):Promise<CryptoKey> {
  if(secret.length<32)throw new Error('native-portal-handles-unavailable');
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`native-portal-resource-v1\0${secret}`)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function encodeNativePortalHandle(env:KeyEnv,value:NativePortalHandle):Promise<string> {
  const parsed=handle.parse(value),iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env.DELIVERY_SESSION_SECRET??''),new TextEncoder().encode(JSON.stringify(parsed))));
  const bytes=new Uint8Array(12+encrypted.length);bytes.set(iv);bytes.set(encrypted,12);return `np1_${base64(bytes)}`;
}
export async function decodeNativePortalHandle(env:KeyEnv,value:string):Promise<NativePortalHandle|null> {
  if(value.length>8192||!/^np1_[A-Za-z0-9_-]+$/.test(value))return null;
  const raw=value.slice(4);let bytes:Uint8Array;
  try{bytes=Uint8Array.from(atob(raw.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));if(base64(bytes)!==raw||bytes.length<29)return null;}catch{return null;}
  for(const secret of [env.DELIVERY_SESSION_SECRET,env.DELIVERY_PREVIOUS_SESSION_SECRET]){
    if(!secret||secret.length<32)continue;
    try{const parsed=handle.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt(
      {name:'AES-GCM',iv:bytes.slice(0,12)},await key(secret),bytes.slice(12)))));
      if(parsed.expires<=Date.now()||parsed.expires>Date.now()+65*60_000)return null;
      return parsed;
    }catch{/* A different purpose/key, tampering or old key is never accepted. */}
  }
  return null;
}
