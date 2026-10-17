import {afterEach,expect,it,vi} from 'vitest';
import {readPortalAuthorityWithinBudget} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import type {SharedProfileAuthorityReadRequest,SharedProfileAuthorityReadResult} from '../../../packages/shared/src/shared-business-profile';
const request:SharedProfileAuthorityReadRequest={protocolVersion:1,workspaceId:'workspace',sourceId:'project-alpha:primary',issuer:'issuer',subject:'subject',principalPublicId:'principal',scopeType:'client',publicId:'client'};
const answer:SharedProfileAuthorityReadResult={ok:true,proof:{protocolVersion:1,workspaceId:'workspace',sourceId:'project-alpha:primary',issuer:'issuer',subject:'subject',authorityRevision:33,contextVersion:'b'.repeat(64),verifiedUntil:new Date(Date.now()+30_000).toISOString(),targets:[{principalPublicId:'principal',scopeType:'client',publicId:'client'}]}};
afterEach(()=>{vi.useRealTimers();});
it.each([6_000,20_000])('accepts a legitimate fresh authority response after %ims without replay',async delay=>{
 vi.useFakeTimers();const reader=vi.fn(()=>new Promise<SharedProfileAuthorityReadResult>(resolve=>setTimeout(()=>resolve(answer),delay)));
 const result=readPortalAuthorityWithinBudget({readAuthority:reader},request);await vi.advanceTimersByTimeAsync(delay);
 expect(await result).toEqual(answer);expect(reader).toHaveBeenCalledExactlyOnceWith(request);expect(vi.getTimerCount()).toBe(0);
});
it('fails closed at thirty seconds for a stalled authority call and never retries',async()=>{
 vi.useFakeTimers();const reader=vi.fn(()=>new Promise<SharedProfileAuthorityReadResult>(()=>{}));let settled=false;
 const result=readPortalAuthorityWithinBudget({readAuthority:reader},request).then(value=>{settled=true;return value;});await vi.advanceTimersByTimeAsync(29_999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);
 expect(await result).toBeNull();expect(reader).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('preserves denied and unavailable responses without treating them as an authority proof',async()=>{
 for(const code of ['denied','unavailable'] as const){const reader=vi.fn(async()=>({ok:false as const,code}));expect(await readPortalAuthorityWithinBudget({readAuthority:reader},request)).toEqual({ok:false,code});expect(reader).toHaveBeenCalledOnce();}
});
