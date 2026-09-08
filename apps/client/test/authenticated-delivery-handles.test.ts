import {afterEach,describe,expect,it,vi} from 'vitest';
import {decodeAuthenticatedDeliveryHandle,encodeAuthenticatedDeliveryHandle,type AuthenticatedDeliveryHandle} from '../src/worker/client-portal/authenticated-delivery-handles';
import type {Env} from '../src/worker/types';

const secret='authenticated-delivery-handle-test-secret-at-least-32-bytes';
const env={DELIVERY_SESSION_SECRET:secret} as Env;
const now=1_790_000_000_000;
const folder=(overrides:Partial<AuthenticatedDeliveryHandle>={})=>({
  v:1,kind:'folder',sourceId:'project-alpha:primary',workspaceId:'workspace-one',identityId:'global-identity-one',eventId:'event-one',
  grantId:'grant-one',grantVersion:3,bindingId:'binding-one',bindingSourceVersion:'binding-v3',path:'',expires:now+60_000,...overrides,
}) as AuthenticatedDeliveryHandle;

afterEach(()=>vi.restoreAllMocks());

describe('authenticated delivery handles',()=>{
  it('round-trips a strict, opaque exact folder coordinate without storage metadata',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const encoded=await encodeAuthenticatedDeliveryHandle(env,folder());
    expect(encoded).toMatch(/^ad1_[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('binding-one');
    expect(encoded).not.toContain('project-alpha:primary');
    await expect(decodeAuthenticatedDeliveryHandle(env,encoded)).resolves.toEqual(folder());
  });

  it('supports file and cursor coordinates while enforcing canonical relative paths',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const file=folder({kind:'file',path:'reports/final.pdf',etag:'"etag-1"'});
    const cursor=folder({kind:'cursor',path:'reports/',after:'final.pdf',entryKind:'file'});
    await expect(decodeAuthenticatedDeliveryHandle(env,await encodeAuthenticatedDeliveryHandle(env,file))).resolves.toEqual(file);
    await expect(decodeAuthenticatedDeliveryHandle(env,await encodeAuthenticatedDeliveryHandle(env,cursor))).resolves.toEqual(cursor);
    await expect(encodeAuthenticatedDeliveryHandle(env,folder({path:'reports//'}))).rejects.toThrow();
    await expect(encodeAuthenticatedDeliveryHandle(env,folder({path:'../reports/'}))).rejects.toThrow();
    await expect(encodeAuthenticatedDeliveryHandle(env,folder({path:'reports\\private/'}))).rejects.toThrow();
    await expect(encodeAuthenticatedDeliveryHandle(env,folder({path:'re\u0301ports/'}))).rejects.toThrow();
  });

  it('rejects tampering, expired values, overlong issuance, and unknown fields',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const encoded=await encodeAuthenticatedDeliveryHandle(env,folder());
    const tampered=`${encoded.slice(0,-1)}${encoded.endsWith('A')?'B':'A'}`;
    await expect(decodeAuthenticatedDeliveryHandle(env,tampered)).resolves.toBeNull();
    await expect(encodeAuthenticatedDeliveryHandle(env,folder({expires:now+60*60_000+1}))).rejects.toThrow(/expiry/);
    await expect(encodeAuthenticatedDeliveryHandle(env,folder({grantVersion:0}))).rejects.toThrow();
    await expect(encodeAuthenticatedDeliveryHandle(env,{...folder(),r2Prefix:'clients/private/'} as unknown as AuthenticatedDeliveryHandle)).rejects.toThrow();
    vi.spyOn(Date,'now').mockReturnValue(now+60_001);
    await expect(decodeAuthenticatedDeliveryHandle(env,encoded)).resolves.toBeNull();
  });

  it('accepts an intact handle encrypted with the configured previous secret only',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const previous={DELIVERY_SESSION_SECRET:'previous-authenticated-delivery-handle-secret-32'} as Env;
    const encoded=await encodeAuthenticatedDeliveryHandle(previous,folder());
    const rotated={DELIVERY_SESSION_SECRET:'current-authenticated-delivery-handle-secret-32',DELIVERY_PREVIOUS_SESSION_SECRET:previous.DELIVERY_SESSION_SECRET} as Env;
    await expect(decodeAuthenticatedDeliveryHandle(rotated,encoded)).resolves.toEqual(folder());
    await expect(decodeAuthenticatedDeliveryHandle({DELIVERY_SESSION_SECRET:rotated.DELIVERY_SESSION_SECRET},encoded)).resolves.toBeNull();
  });
});
