import { WorkerEntrypoint } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "./types";
import {
  applyProjectAlphaDeliveryIntent,
  applyProjectAlphaDeliveryIntentRevoke,
  applyProjectAlphaDeliveryPreflight,
  applyProjectAlphaDeliveryRpcBudget,
  resolveProjectAlphaDeliverySourceProof,
} from "./project-alpha-delivery-intents";

const inputSchema=z.object({
  protocolVersion:z.literal(1), sourceId:z.string().trim().min(1).max(128),
  applicationKey:z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]+$/),
  deliveryId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  intentKind:z.enum(["preflight","provision","revoke"]), body:z.string().min(2).max(16*1024),
  connectorProof:z.object({revision:z.number().int().nonnegative(),version:z.number().int().nonnegative()}).strict(),
}).strict();

export type ProjectAlphaDeliveryIntentIngressInput=z.infer<typeof inputSchema>;
export type ProjectAlphaDeliveryIntentIngressResult=
  |{ok:true;protocolVersion:1;result:Record<string,unknown>}
  |{ok:false;protocolVersion:1;code:string;retryable:boolean};

async function fingerprint(body:string):Promise<string>{
  const value=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body)));
  return [...value].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}

function failure(error:unknown):ProjectAlphaDeliveryIntentIngressResult{
  const status=error instanceof HTTPException?error.status:500;
  const message=error instanceof Error?error.message:"Delivery intent processing failed";
  const code=status===409?"authority_or_state_conflict":status===404?"not_found_or_disabled":
    status===400?"invalid_intent":status===429?"rate_limited":"temporarily_unavailable";
  if(status>=500)console.error(JSON.stringify({event:"project_alpha.delivery_intent_rpc_failed",code}));
  else console.warn(JSON.stringify({event:"project_alpha.delivery_intent_rpc_rejected",code}));
  return{ok:false,protocolVersion:1,code,retryable:status===408||status===429||status>=500||message.includes("concurrently")};
}

/**
 * Route-less private target for the existing Ops Sync event receiver. The
 * caller supplies only authenticated connector metadata; Operations rechecks
 * it before parsing or mutating a delivery receipt.
 */
export class ProjectAlphaDeliveryIntentIngress extends WorkerEntrypoint<Env>{
  async ingestProjectAlphaDeliveryIntent(value:unknown):Promise<ProjectAlphaDeliveryIntentIngressResult>{
    return processProjectAlphaDeliveryIntentIngress(this.env,value);
  }
}

export async function processProjectAlphaDeliveryIntentIngress(env:Env,value:unknown):Promise<ProjectAlphaDeliveryIntentIngressResult>{
  const parsed=inputSchema.safeParse(value);
  if(!parsed.success)return{ok:false,protocolVersion:1,code:"invalid_rpc_envelope",retryable:false};
  const input=parsed.data;
  if(input.intentKind!=="preflight"&&env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED!=="true")
    return{ok:false,protocolVersion:1,code:"not_found_or_disabled",retryable:false};
  try{
    const authority=await resolveProjectAlphaDeliverySourceProof(env,input.sourceId,input.applicationKey,input.connectorProof);
    await applyProjectAlphaDeliveryRpcBudget(env,authority.source,input.intentKind);
    let body:unknown;
    try{body=JSON.parse(input.body);}catch{return{ok:false,protocolVersion:1,code:"invalid_intent",retryable:false};}
    const auth={deliveryId:input.deliveryId,fingerprint:await fingerprint(input.body)};
    const result=input.intentKind==="preflight"
      ?await applyProjectAlphaDeliveryPreflight(env,body,auth,authority.source,input.applicationKey,authority.proof)
      :input.intentKind==="revoke"
        ?await applyProjectAlphaDeliveryIntentRevoke(env,body,auth,authority.source,input.applicationKey,authority.proof)
        :await applyProjectAlphaDeliveryIntent(env,body,auth,authority.source,input.applicationKey,authority.proof);
    return{ok:true,protocolVersion:1,result};
  }catch(error){return failure(error);}
}
