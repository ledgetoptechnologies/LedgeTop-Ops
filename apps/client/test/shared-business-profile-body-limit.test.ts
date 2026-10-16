import { expect,it } from 'vitest';
import { readBoundedClientJson } from '../src/worker/bounded-json';
it('cancels an oversized chunked profile body before reading the rest',async()=>{
 let cancelled=false,pulls=0;
 const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(9000));},cancel(){cancelled=true;}},{highWaterMark:0});
 const request=new Request('https://portal.example.test/api/client/v2/workspaces/one/business-profile',
  {method:'PATCH',body,duplex:'half'} as RequestInit&{duplex:string});
 await expect(readBoundedClientJson(request,16384)).rejects.toMatchObject({status:413});
 expect(cancelled).toBe(true);expect(pulls).toBe(2);
});
it('rejects invalid UTF-8 instead of silently changing submitted business data',async()=>{
 const request=new Request('https://portal.example.test/api/client/v2/workspaces/one/business-profile',
  {method:'PATCH',body:new Uint8Array([123,34,110,97,109,101,34,58,34,255,34,125])});
 await expect(readBoundedClientJson(request,16384)).rejects.toMatchObject({status:400});
});
