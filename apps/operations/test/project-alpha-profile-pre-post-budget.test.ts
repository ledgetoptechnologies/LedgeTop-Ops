import {afterEach,expect,it,vi} from 'vitest';
import {PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT as endpoint,sendProjectAlphaDirectoryClientContactProfileUpdate} from '../src/worker/project-alpha-directory-profile-api-v2';
const source='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',application='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',epoch='cccccccc-cccc-4ccc-8ccc-cccccccccccc',requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',publicId='1'.repeat(32);
const connection={baseUrl:'https://pa.example.test',apiKey:'local-test-secret',expectedSourceInstanceId:source,expectedApplicationId:application,expectedHistoryEpoch:epoch};
const command={commandId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',expectedRevision:'1',expectedAuthorizationGeneration:'7',profile:{name:'Synthetic Client',email:'',phone:'555-0148',addressLine1:'',addressLine2:'',city:'',state:'',postalCode:'',country:''}};
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});
const capabilities=()=>json({apiVersion:'2',sourceInstanceId:source,applicationId:application,historyEpoch:epoch,requestId,grantedCapabilities:[{name:'api.capabilities.read'},{name:'directory.clients.write'}],implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},endpoint]});
const ack=()=>json({sourceInstanceId:source,applicationId:application,historyEpoch:epoch,requestId,replayed:false,result:{resource:{type:'client',publicId,revision:'2'},authorizationGeneration:'7'}});
afterEach(()=>vi.useRealTimers());
it.each([16_000,20_000])('starts the ten-second PA network budget only after a %ims fresh authority gate',async delay=>{
 vi.useFakeTimers();let gateDone=false;const gate=vi.fn(async(body:string)=>{expect(body).toBe(JSON.stringify(command));await new Promise(resolve=>setTimeout(resolve,delay));gateDone=true;});
 const send=vi.fn<typeof fetch>(async(url,init)=>{if(String(url).endsWith('/capabilities'))return capabilities();expect(gateDone).toBe(true);expect(init?.signal?.aborted).toBe(false);expect(init?.body).toBe(JSON.stringify(command));return ack();});
 const result=sendProjectAlphaDirectoryClientContactProfileUpdate(connection,publicId,command,send,gate);await vi.advanceTimersByTimeAsync(delay);
 expect(await result).toMatchObject({status:'acknowledged'});expect(gate).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
});
it('still aborts a stalled PA request ten seconds after the actual POST, never replaying it',async()=>{
 vi.useFakeTimers();const gate=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,20_000));});let posted=false;
 const send=vi.fn<typeof fetch>(async(url,init)=>{if(String(url).endsWith('/capabilities'))return capabilities();posted=true;expect(init?.signal?.aborted).toBe(false);return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
 let settled=false;const result=sendProjectAlphaDirectoryClientContactProfileUpdate(connection,publicId,command,send,gate).then(v=>{settled=true;return v;});await vi.advanceTimersByTimeAsync(20_000);expect(posted).toBe(true);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(9_999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);
 expect(await result).toMatchObject({status:'uncertain',reason:'timeout'});expect(send).toHaveBeenCalledTimes(2);expect(gate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('does not POST or replay when the fresh gate rejects',async()=>{
 const gate=vi.fn(async()=>{throw new Error('authority changed');});const send=vi.fn<typeof fetch>(async url=>{expect(String(url).endsWith('/capabilities')).toBe(true);return capabilities();});
 expect(await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,publicId,command,send,gate)).not.toMatchObject({status:'acknowledged'});expect(gate).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce();
});
it('reproduces why awaiting authority inside fetch consumes the network timer',async()=>{
 vi.useFakeTimers();let abortedBeforeNetwork=false;const send=vi.fn<typeof fetch>(async(url,init)=>{if(String(url).endsWith('/capabilities'))return capabilities();await new Promise(resolve=>setTimeout(resolve,16_000));abortedBeforeNetwork=init?.signal?.aborted===true;if(abortedBeforeNetwork)throw new Error('already aborted');return ack();});
 const result=sendProjectAlphaDirectoryClientContactProfileUpdate(connection,publicId,command,send);await vi.advanceTimersByTimeAsync(16_000);expect(await result).toMatchObject({status:'uncertain',reason:'timeout'});expect(abortedBeforeNetwork).toBe(true);
});
