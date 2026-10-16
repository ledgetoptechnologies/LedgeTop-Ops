import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import type { SharedProfileAuthorityTransition,SharedProfilePortalProof,SharedProfilePortalResult,SharedProfilePortalUpdate } from '../../../../packages/shared/src/shared-business-profile';
import { bindSharedProfilePortalIdentity,transitionSharedProfilePortalAuthority } from './shared-profile-portal-authority';
import { readEditableSharedPortalProfiles,updateSharedPortalProfile } from './shared-profile-portal-composer';
/** Private named service binding. Never expose these proof-bearing methods as HTTP. */
export class SharedProfilePortalIngress extends WorkerEntrypoint<Env>{
 readProfile(input:SharedProfilePortalProof){return readEditableSharedPortalProfiles(this.env,input);}
 transitionAuthority(input:SharedProfileAuthorityTransition){return transitionSharedProfilePortalAuthority(this.env,input);}
 bindProfileIdentity(input:SharedProfilePortalProof){return bindSharedProfilePortalIdentity(this.env,input);}
 async updateProfile(input:SharedProfilePortalUpdate):Promise<SharedProfilePortalResult>{
  return updateSharedPortalProfile(this.env,input);
 }
}
