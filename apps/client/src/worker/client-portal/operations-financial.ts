import type { ClientPortalServiceMetadataRequestV1 } from "../../../../../packages/shared/src/client-portal-service-metadata";
import type { VerifiedClientPrincipal } from "./types";
import { readNativeOperationsPortalHomes } from "./operations-native-recipient-read";

const MAX_BYTES=512*1024,TIMEOUT_MS=12_000;
export interface OperationsFinancialBinding{readFinancialDocuments(input:ClientPortalServiceMetadataRequestV1):Promise<string>}
export type OperationsFinancialEnv={DELIVERY_DB:D1Database;CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED?:string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED?:string;
  CLIENT_PORTAL_NATIVE_FINANCIAL_READER?:OperationsFinancialBinding};
export type PortalFinancialDocument=Readonly<{publicId:string;kind:"invoice"|"contract"|"project_invoice";status:string;
  currency:string;total:string;amountPaid:string|null;balanceDue:string|null;documentUrl:string|null;actionUrl:string|null}>;
export type PortalFinancialCollection=Readonly<{grantId:string;revision:number;documents:readonly PortalFinancialDocument[]}>;
export type PortalFinancialResult=Readonly<{ok:true;collections:readonly PortalFinancialCollection[]}>
  |Readonly<{ok:false;code:"disabled"|"denied"|"unavailable"}>;

const plain=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value)
  &&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const bounded=(value:unknown,max:number):value is string=>typeof value==="string"&&value.length>0&&value.length<=max&&value.trim()===value;
const money=(value:unknown):value is string=>typeof value==="string"&&/^(?:0|[1-9][0-9]{0,17})\.[0-9]{2}$/.test(value);
function safeLink(value:unknown):value is string|null{if(value===null)return true;if(typeof value!=="string"||value.length>2048)return false;
  try{const url=new URL(value),keys=[...url.searchParams.keys()];return url.protocol==="https:"&&!url.username&&!url.password&&!url.hash
    &&url.pathname==="/"&&keys.length===2&&keys.filter(key=>key==="page").length===1&&keys.filter(key=>key==="token").length===1
    &&(url.searchParams.get("page")==="public-doc"||url.searchParams.get("page")==="stripe-checkout")
    &&/^[A-Za-z0-9_-]{16,64}$/.test(url.searchParams.get("token")??"");}catch{return false;}}
function decode(wire:unknown,request:ClientPortalServiceMetadataRequestV1):PortalFinancialCollection[]|null{
  if(typeof wire!=="string"||new TextEncoder().encode(wire).byteLength>MAX_BYTES)return null;
  try{
    const value:unknown=JSON.parse(wire);if(!plain(value)||!exact(value,["ok","protocolVersion","authorityId","workspaceId","ownershipEpoch","grantRevision","collections"])||value.ok!==true||value.protocolVersion!==1
      ||value.authorityId!==request.authorityId||value.workspaceId!==request.workspaceId
      ||value.ownershipEpoch!==request.ownershipEpoch||value.grantRevision!==request.grantRevision
      ||!Array.isArray(value.collections)||value.collections.length>20)return null;
    const collections:PortalFinancialCollection[]=[];
    const grantIds=new Set<string>();
    for(const candidate of value.collections){if(!plain(candidate)||!exact(candidate,["status","grantId","revision","value"])||candidate.status!=="ok"
      ||typeof candidate.grantId!=="string"||typeof candidate.revision!=="number"||!Number.isSafeInteger(candidate.revision)
      ||candidate.revision<1||grantIds.has(candidate.grantId)||!plain(candidate.value)
      ||!exact(candidate.value,["selector","snapshotSha256","documents"])||!Array.isArray(candidate.value.documents)
      ||candidate.value.documents.length>10_000)return null;
      grantIds.add(candidate.grantId);
      const documents:PortalFinancialDocument[]=[];
      for(const item of candidate.value.documents){if(!plain(item)||!exact(item,["publicId","kind","status","currency","total","amountPaid","balanceDue","documentUrl","actionUrl"])
        ||!bounded(item.publicId,191)||!bounded(item.status,64)
        ||!(item.kind==="invoice"||item.kind==="contract"||item.kind==="project_invoice")
        ||typeof item.currency!=="string"||!/^[A-Z]{3}$/.test(item.currency)||!money(item.total)
        ||!(item.amountPaid===null||money(item.amountPaid))||!(item.balanceDue===null||money(item.balanceDue))
        ||!safeLink(item.documentUrl)||!safeLink(item.actionUrl))return null;
        documents.push({publicId:item.publicId,kind:item.kind,status:item.status,currency:item.currency,total:item.total,
          amountPaid:item.amountPaid,balanceDue:item.balanceDue,documentUrl:item.documentUrl,actionUrl:item.actionUrl});}
      collections.push({grantId:candidate.grantId,revision:candidate.revision,documents});}
    return collections;
  }catch{return null;}
}

export async function readPortalFinancialDocuments(env:OperationsFinancialEnv,
  principal:Pick<VerifiedClientPrincipal,"issuer"|"subject">,authorityId:string):Promise<PortalFinancialResult>{
  if(env.CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED!=="true"||!env.CLIENT_PORTAL_NATIVE_FINANCIAL_READER
    ||env.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED!=="true")return{ok:false,code:"disabled"};
  const homes=await readNativeOperationsPortalHomes(env.DELIVERY_DB,principal,true);
  const matches=homes?.filter(home=>home.authorityId===authorityId)??[];
  if(matches.length!==1)return{ok:false,code:homes?"denied":"unavailable"};
  const home=matches[0]!;
  const request:ClientPortalServiceMetadataRequestV1={protocolVersion:1,authorityId:home.authorityId,
    workspaceId:home.workspaceId,ownershipEpoch:home.ownershipEpoch,grantRevision:home.grantRevision,
    issuer:principal.issuer,subject:principal.subject};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const wire=await Promise.race([env.CLIENT_PORTAL_NATIVE_FINANCIAL_READER.readFinancialDocuments(request),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error("financial-rpc-timeout")),TIMEOUT_MS);})]);
    const collections=decode(wire,request);if(!collections)return{ok:false,code:"unavailable"};
    const after=await readNativeOperationsPortalHomes(env.DELIVERY_DB,principal,true);
    const current=after?.filter(candidate=>candidate.authorityId===authorityId)??[];
    if(current.length!==1||current[0]!.workspaceId!==home.workspaceId||current[0]!.ownershipEpoch!==home.ownershipEpoch
      ||current[0]!.grantRevision!==home.grantRevision)return{ok:false,code:"denied"};
    return{ok:true,collections};
  }catch{return{ok:false,code:"unavailable"};}finally{if(timer!==undefined)clearTimeout(timer);}
}
