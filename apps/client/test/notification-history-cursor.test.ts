import {describe,expect,it} from 'vitest';
import {decodeNotificationHistoryCursor,encodeNotificationHistoryCursor,notificationHistoryScope} from '../src/worker/client-portal/notification-history-cursor';
import type {Env} from '../src/worker/types';
import type {VerifiedClientPrincipal} from '../src/worker/client-portal/types';
import {notificationHistoryCoverage} from '../src/worker/client-portal/notification-history';
import {legacyNotificationCursor,v2NotificationCursor} from './helpers/legacy-notification-cursor';

const env={DELIVERY_SESSION_SECRET:'notification-history-test-secret-at-least-32-bytes'} as Env;
const actor={issuer:'https://team.cloudflareaccess.com',subject:'client-one',email:'one@example.test'} satisfies VerifiedClientPrincipal;
const other={...actor,subject:'client-two'};

describe('notification history cursor',()=>{
  it('reports deterministic truthful ledger coverage',()=>{
    const base={notifications:true,primaryFeedback:true,nativeRequestsEnabled:true,nativeRequestSchema:true,nativeFeedbackEnabled:true,nativeFeedbackSchema:true};
    expect(notificationHistoryCoverage({...base,native:false})).toEqual({requests:'included',feedback:'included'});
    expect(notificationHistoryCoverage({...base,native:false,notifications:false})).toEqual({requests:'omitted_schema_unavailable',feedback:'included'});
    expect(notificationHistoryCoverage({...base,native:true,nativeRequestsEnabled:false,nativeFeedbackEnabled:false})).toEqual({requests:'omitted_feature_disabled',feedback:'omitted_feature_disabled'});
    expect(notificationHistoryCoverage({...base,native:true,nativeRequestSchema:false,nativeFeedbackSchema:false})).toEqual({requests:'omitted_schema_unavailable',feedback:'omitted_schema_unavailable'});
  });
  it('binds encrypted continuations to actor and exact source/workspace/root scope',async()=>{
    const scopeA=await notificationHistoryScope({sourceId:'source-a',workspaceId:'workspace-a',rootType:'organization',rootPublicId:'root-a',identityId:'identity-a'});
    const scopeB=await notificationHistoryScope({sourceId:'source-a',workspaceId:'workspace-b',rootType:'organization',rootPublicId:'root-a',identityId:'identity-a'});
    expect(scopeA).not.toBe(scopeB);
    const encoded=await encodeNotificationHistoryCursor(env,actor,{v:3,scope:scopeA,asOf:'2026-09-06T12:00:00.000Z',coverage:{requests:'included',feedback:'included',nativeDelivery:'included'},water:{requests:9,feedback:4,nativeDelivery:2},after:['2026-09-06T11:00:00.000Z','feedback:n1'],expires:Date.now()+60_000});
    expect(encoded).not.toContain(scopeA);expect((await decodeNotificationHistoryCursor(env,actor,encoded))?.scope).toBe(scopeA);
    await expect(decodeNotificationHistoryCursor(env,other,encoded)).resolves.toBeNull();
    const tampered=`${encoded.slice(0,-1)}${encoded.endsWith('A')?'B':'A'}`;
    await expect(decodeNotificationHistoryCursor(env,actor,tampered)).resolves.toBeNull();
  });
  it('rejects a nonzero watermark for an omitted ledger',async()=>{
    await expect(encodeNotificationHistoryCursor(env,actor,{v:3,scope:'a'.repeat(64),asOf:'2026-09-06T12:00:00.000Z',coverage:{requests:'omitted_feature_disabled',feedback:'included',nativeDelivery:'omitted_schema_unavailable'},
      water:{requests:1,feedback:2,nativeDelivery:0},after:['2026-09-06T11:00:00.000Z','feedback:n1'],expires:Date.now()+60_000})).rejects.toThrow(/omitted request watermark/);
  });
  it('rejects the prior cursor contract instead of adding delivery rows to an in-flight page',async()=>{
    const legacy = await legacyNotificationCursor(env.DELIVERY_SESSION_SECRET!, actor);
    await expect(decodeNotificationHistoryCursor(env, actor, legacy)).resolves.toBeNull();
    const v2 = await v2NotificationCursor(env.DELIVERY_SESSION_SECRET!, actor);
    await expect(decodeNotificationHistoryCursor(env, actor, v2)).resolves.toBeNull();
  });
  it('rejects a nonzero native-delivery watermark when that ledger is omitted',async()=>{
    await expect(encodeNotificationHistoryCursor(env,actor,{v:3,scope:'b'.repeat(64),asOf:'2026-09-06T12:00:00.000Z',coverage:{requests:'included',feedback:'included',nativeDelivery:'omitted_schema_unavailable'},
      water:{requests:1,feedback:2,nativeDelivery:1},after:['2026-09-06T11:00:00.000Z','request:n1'],expires:Date.now()+60_000})).rejects.toThrow(/omitted native delivery watermark/);
  });
});
