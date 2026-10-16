import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { OutboundMail } from '../src/worker/mailer';
import { selectSealedNotificationMail } from '../src/worker/sealed-notification-mail';

const current = { to:'recipient@example.test',fromName:'Ledge Top Client Delivery',subject:'Delivery available',
  text:'Open https://client.example.test/portal/deliveries',html:'<p>Open your portal</p>',messageIdKey:'stable-batch-id' };
const legacy = { ...current,fromName:'LTDS Client Delivery' };
const digest = async (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = (mail:OutboundMail) => digest({authority:'current-exact-authority',mail});

it('uses new copy for an unsealed publication and retries that exact version',async()=>{
 const first=await selectSealedNotificationMail(current,()=>legacy,null,fingerprint);
 expect(first).toEqual({mail:current,fingerprint:await fingerprint(current)});
 expect(await selectSealedNotificationMail(current,()=>legacy,first!.fingerprint,fingerprint)).toEqual(first);
});

it('reconstructs only the exact historical template under its original fingerprint',async()=>{
 const hash=await fingerprint(legacy);
 expect(await selectSealedNotificationMail(current,()=>legacy,hash,fingerprint)).toEqual({mail:legacy,fingerprint:hash});
});

it.each(['recipient','link','message_id','authority','invented_hash'] as const)('does not adopt changed %s under a sealed fingerprint',async change=>{
 const hash=change==='invented_hash'?'f'.repeat(64):await fingerprint(legacy);
 const next={...current,...(change==='recipient'?{to:'other@example.test'}:change==='link'?{text:'Open https://changed.example.test/portal/deliveries'}:change==='message_id'?{messageIdKey:'different-id'}:{})};
 const revised=(mail:OutboundMail)=>change==='authority'?digest({authority:'different-authority',mail}):fingerprint(mail);
 expect(await selectSealedNotificationMail(next,()=>({...next,fromName:legacy.fromName}),hash,revised)).toBeNull();
});
