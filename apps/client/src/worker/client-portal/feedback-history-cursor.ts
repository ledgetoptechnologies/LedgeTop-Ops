import { z } from "zod";
import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";

const cursorSchema=z.object({v:z.literal(1),scope:z.string().length(64),asOf:z.string().datetime(),water:z.number().int().nonnegative(),
  after:z.tuple([z.string().datetime(),z.string().min(1).max(128)]),expires:z.number().int().positive()}).strict();
export type FeedbackHistoryCursor=z.infer<typeof cursorSchema>;
const encoder=new TextEncoder();
function bytes(value:string):Uint8Array|null{try{const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/")),out=new Uint8Array(raw.length);
  for(let index=0;index<raw.length;index++)out[index]=raw.charCodeAt(index);return out;}catch{return null;}}
function text(value:Uint8Array):string{let raw="";for(const byte of value)raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
async function key(secret:string):Promise<CryptoKey>{if(secret.length<32)throw new Error("feedback-history-cursor-unavailable");
  const material=await crypto.subtle.digest("SHA-256",encoder.encode(`portal-feedback-history-v1\0${secret}`));
  return crypto.subtle.importKey("raw",material,{name:"AES-GCM"},false,["encrypt","decrypt"]);}
function aad(actor:VerifiedClientPrincipal){return encoder.encode(`portal-feedback-history-v1\0${actor.issuer}\0${actor.subject}`);}
export async function feedbackHistoryScope(value:unknown):Promise<string>{const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(JSON.stringify(value))));
  return [...digest].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
export async function encodeFeedbackHistoryCursor(env:Env,actor:VerifiedClientPrincipal,value:FeedbackHistoryCursor):Promise<string>{
  const iv=crypto.getRandomValues(new Uint8Array(12)),plain=encoder.encode(JSON.stringify(cursorSchema.parse(value)));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad(actor)},await key(env.DELIVERY_SESSION_SECRET??""),plain));
  const payload=new Uint8Array(iv.length+encrypted.length);payload.set(iv);payload.set(encrypted,iv.length);return `fh1_${text(payload)}`;
}
export async function decodeFeedbackHistoryCursor(env:Env,actor:VerifiedClientPrincipal,value:string):Promise<FeedbackHistoryCursor|null>{
  if(value.length>4096||!value.startsWith("fh1_"))return null;const payload=bytes(value.slice(4));if(!payload||payload.length<29)return null;
  try{const secret=env.DELIVERY_SESSION_SECRET??"";if(secret.length<32)return null;
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:payload.slice(0,12),additionalData:aad(actor)},await key(secret),payload.slice(12));
    return cursorSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain)));
  }catch{return null;}
}
