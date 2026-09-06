import {z} from 'zod';
import type {Env} from '../types';
import type {VerifiedClientPrincipal} from './types';

const ledger=z.enum(['included','omitted_feature_disabled','omitted_schema_unavailable']);
const schema=z.object({v:z.literal(1),scope:z.string().length(64),asOf:z.string().datetime(),coverage:z.object({requests:ledger,feedback:ledger}).strict(),
  water:z.object({requests:z.number().int().nonnegative(),feedback:z.number().int().nonnegative()}).strict(),
  after:z.tuple([z.string().datetime(),z.string().min(1).max(180)]),expires:z.number().int().positive()}).strict().superRefine((value,ctx)=>{
    if(value.coverage.requests!=='included'&&value.water.requests!==0)ctx.addIssue({code:'custom',path:['water','requests'],message:'omitted request watermark must be zero'});
    if(value.coverage.feedback!=='included'&&value.water.feedback!==0)ctx.addIssue({code:'custom',path:['water','feedback'],message:'omitted feedback watermark must be zero'});
  });
export type NotificationHistoryCursor=z.infer<typeof schema>;
const encoder=new TextEncoder();
const b64=(bytes:Uint8Array)=>{let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const bytes=(value:string)=>{try{const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}catch{return null;}};
async function key(secret:string){if(secret.length<32)throw new Error('notification-history-cursor-unavailable');
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(`portal-notification-history-v1\0${secret}`)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
const aad=(actor:VerifiedClientPrincipal)=>encoder.encode(`portal-notification-history-v1\0${actor.issuer}\0${actor.subject}`);
export async function notificationHistoryScope(value:unknown){const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value))));return [...digest].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function encodeNotificationHistoryCursor(env:Env,actor:VerifiedClientPrincipal,value:NotificationHistoryCursor){
  const iv=crypto.getRandomValues(new Uint8Array(12)),plain=encoder.encode(JSON.stringify(schema.parse(value))),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(actor)},await key(env.DELIVERY_SESSION_SECRET??''),plain));
  const payload=new Uint8Array(iv.length+cipher.length);payload.set(iv);payload.set(cipher,iv.length);return `nh1_${b64(payload)}`;
}
export async function decodeNotificationHistoryCursor(env:Env,actor:VerifiedClientPrincipal,value:string){
  if(value.length>4096||!value.startsWith('nh1_'))return null;const payload=bytes(value.slice(4));if(!payload||payload.length<29)return null;
  try{const secret=env.DELIVERY_SESSION_SECRET??'';if(secret.length<32)return null;const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:payload.slice(0,12),additionalData:aad(actor)},await key(secret),payload.slice(12));
    return schema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)));}catch{return null;}
}
