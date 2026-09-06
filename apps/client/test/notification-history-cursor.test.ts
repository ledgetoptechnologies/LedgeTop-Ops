import {describe,expect,it} from 'vitest';
import {decodeNotificationHistoryCursor,encodeNotificationHistoryCursor,notificationHistoryScope} from '../src/worker/client-portal/notification-history-cursor';
import type {Env} from '../src/worker/types';
import type {VerifiedClientPrincipal} from '../src/worker/client-portal/types';

const env={DELIVERY_SESSION_SECRET:'notification-history-test-secret-at-least-32-bytes'} as Env;
const actor={issuer:'https://team.cloudflareaccess.com',subject:'client-one',email:'one@example.test'} satisfies VerifiedClientPrincipal;
const other={...actor,subject:'client-two'};

describe('notification history cursor',()=>{
  it('binds encrypted continuations to actor and exact source/workspace/root scope',async()=>{
    const scopeA=await notificationHistoryScope({sourceId:'source-a',workspaceId:'workspace-a',rootType:'organization',rootPublicId:'root-a',identityId:'identity-a'});
    const scopeB=await notificationHistoryScope({sourceId:'source-a',workspaceId:'workspace-b',rootType:'organization',rootPublicId:'root-a',identityId:'identity-a'});
    expect(scopeA).not.toBe(scopeB);
    const encoded=await encodeNotificationHistoryCursor(env,actor,{v:1,scope:scopeA,asOf:'2026-09-06T12:00:00.000Z',water:{requests:9,feedback:4},after:['2026-09-06T11:00:00.000Z','feedback:n1'],expires:Date.now()+60_000});
    expect(encoded).not.toContain(scopeA);expect((await decodeNotificationHistoryCursor(env,actor,encoded))?.scope).toBe(scopeA);
    await expect(decodeNotificationHistoryCursor(env,other,encoded)).resolves.toBeNull();
    const tampered=`${encoded.slice(0,-1)}${encoded.endsWith('A')?'B':'A'}`;
    await expect(decodeNotificationHistoryCursor(env,actor,tampered)).resolves.toBeNull();
  });
});
