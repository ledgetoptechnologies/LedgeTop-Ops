/** Private service binding contract. Identity and targets are derived by Client, never the browser. */
export type SharedProfileTarget = Readonly<{principalPublicId:string;scopeType:'client'|'organization';publicId:string}>;
export type SharedProfilePortalProof = Readonly<{protocolVersion:1;workspaceId:string;sourceId:string;
 issuer:string;subject:string;authorityRevision:number;contextVersion:string;verifiedUntil:string;targets:readonly SharedProfileTarget[]}>;
export type SharedProfilePortalUpdate = SharedProfilePortalProof & Readonly<{grantId:string;expectedVersion:number;
 mutationId:string;profile:Readonly<Record<string,string>>}>;
export type SharedProfileAuthorityTransition = Readonly<{protocolVersion:1;operationId:string;workspaceId:string;
 sourceId:string;expectedRevision:number;revision:number;state:'active'|'blocked'}>;
export type SharedProfilePortalView = Readonly<{grantId:string;kind:'organization'|'client';version:number;
 profile:Readonly<Record<string,string>>;editable:boolean}>;
export type SharedProfilePortalResult = Readonly<{ok:true;profiles:readonly SharedProfilePortalView[]}>
 | Readonly<{ok:false;code:'denied'|'unavailable'|'conflict'|'invalid'}>;
export interface SharedProfilePortalBinding {
 readProfile(input:SharedProfilePortalProof):Promise<SharedProfilePortalResult>;
 updateProfile(input:SharedProfilePortalUpdate):Promise<SharedProfilePortalResult>;
 bindProfileIdentity(input:SharedProfilePortalProof):Promise<{ok:boolean;bound?:number}>;
 transitionAuthority(input:SharedProfileAuthorityTransition):Promise<{ok:boolean;revision?:number}>;
}
export type SharedProfileAuthorityReadRequest=Readonly<{protocolVersion:1;workspaceId:string;sourceId:string;issuer:string;subject:string;
 principalPublicId:string;scopeType:'client'|'organization';publicId:string}>;
export type SharedProfileAuthorityReadResult=Readonly<{ok:true;proof:SharedProfilePortalProof}>|Readonly<{ok:false;code:'denied'|'unavailable'}>;
export interface SharedProfilePortalAuthorityBinding{readAuthority(input:SharedProfileAuthorityReadRequest):Promise<SharedProfileAuthorityReadResult>}
