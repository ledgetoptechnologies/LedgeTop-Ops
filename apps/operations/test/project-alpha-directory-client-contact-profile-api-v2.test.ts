import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT,
  probeConfiguredProjectAlphaDirectoryClientContactProfile,
  sendProjectAlphaDirectoryClientContactProfileUpdate,
  sendConfiguredProjectAlphaDirectoryClientContactProfileUpdate,
  validatedProjectAlphaDirectoryClientContactProfileAcknowledgement,
  sendConfiguredProjectAlphaDirectoryCreate,
  sendProjectAlphaDirectoryCreate,
  sendProjectAlphaDirectoryProfileUpdate,
  validatedProjectAlphaDirectoryCreateGenerationConflict,
  type ProjectAlphaDirectoryClientCreateCommand,
  type ProjectAlphaDirectoryClientCreateProfile,
  type ProjectAlphaDirectoryClientUpdateProfile,
  type ProjectAlphaDirectoryOrganizationProfile,
  type ProjectAlphaDirectoryProfileUpdateCommand,
} from "../src/worker/project-alpha-directory-profile-api-v2";
import type { ProjectAlphaApiV2Endpoint } from "../src/worker/project-alpha-api-v2";

const sourceId = "project-alpha:source-a";
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const commandId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const clientId = "1".repeat(32);
const organizationId = "2".repeat(32);
const connection = { baseUrl: "https://source-a.example.test", apiKey: "transport-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true, baseUrl: connection.baseUrl, apiKey: connection.apiKey, sourceInstanceId: source, applicationId: application, historyEpoch: epoch } } }) };
const organizationProfile: ProjectAlphaDirectoryOrganizationProfile = { name: "Example Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100", addressLine1: "1 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
const clientProfile: ProjectAlphaDirectoryClientCreateProfile = { name: "Example Client", email: "client@example.test", phone: "512-555-0101", clientType: "business", addressLine1: "2 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
const clientUpdateProfile: ProjectAlphaDirectoryClientUpdateProfile = { name: "Example Client Updated", email: "client@example.test", phone: "512-555-0101", addressLine1: "2 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };

function endpoint(kind: "client" | "organization", operation: "create" | "update"): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return operation === "create"
    ? { method: "POST", path: `/api/v2/directory/${plural}/commands`, requiredCapability: `directory.${plural}.create`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }
    : { method: "POST", path: `/api/v2/directory/${plural}/{publicId}/profile/commands`, requiredCapability: `directory.${plural}.write`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function capabilities(required: ProjectAlphaApiV2Endpoint, extraGrantedCapabilities: string[] = []) {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId,
    grantedCapabilities: [{ name: "api.capabilities.read" }, { name: required.requiredCapability }, ...extraGrantedCapabilities.map(name => ({ name }))],
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, required] };
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers } });
}
function updateReceipt(kind: "client" | "organization", publicId: string, revision = "2", generation = "7") {
  return { sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: false, result: { resource: { type: kind, publicId, revision }, authorizationGeneration: generation } };
}
function createReceipt(kind: "client" | "organization", externalId: string, publicId: string, replayed = false, generation = "1") {
  return { sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed, result: { resource: { type: kind, id: externalId, publicId, revision: "1" }, authorizationGeneration: generation } };
}

const neutral=PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT;
const command={commandId,expectedRevision:'1',expectedAuthorizationGeneration:'7',profile:clientUpdateProfile};
describe('identity-safe PA client contact profile transport',()=>{
  it('uses only the neutral endpoint, preserves exact CAS/idempotent bodies, and records trusted neutral acknowledgement evidence',async()=>{
    let writes=0;const bodies:string[]=[];
    const send=vi.fn<typeof fetch>(async(url,init)=>{
      expect(new URL(String(url)).origin).toBe(connection.baseUrl);
      if(String(url).endsWith('/capabilities'))return json(capabilities(neutral));
      expect(String(url)).toBe(`${connection.baseUrl}/api/v2/directory/clients/${clientId}/contact-profile/commands`);
      expect(init).toMatchObject({method:'POST',redirect:'manual',credentials:'omit',cache:'no-store'});
      const h=new Headers(init?.headers);expect(h.get('X-PA-Source-Instance-ID')).toBe(source);expect(h.get('X-PA-Application-ID')).toBe(application);expect(h.get('X-PA-History-Epoch')).toBe(epoch);
      bodies.push(String(init?.body));return json({...updateReceipt('client',clientId),replayed:writes++>0});
    });
    const first=await sendConfiguredProjectAlphaDirectoryClientContactProfileUpdate(env,sourceId,clientId,command,send);
    const replay=await sendConfiguredProjectAlphaDirectoryClientContactProfileUpdate(env,sourceId,clientId,command,send);
    expect(first).toMatchObject({status:'acknowledged',response:{replayed:false}});expect(replay).toMatchObject({status:'acknowledged',response:{replayed:true}});
    expect(bodies).toEqual([JSON.stringify(command),JSON.stringify(command)]);
    expect(Object.keys(JSON.parse(bodies[0]!))).toEqual(['commandId','expectedRevision','expectedAuthorizationGeneration','profile']);
    expect(validatedProjectAlphaDirectoryClientContactProfileAcknowledgement(first)).toMatchObject({command,destinationOrigin:connection.baseUrl});
    expect(validatedProjectAlphaDirectoryClientContactProfileAcknowledgement({...first})).toBeNull();
    const legacySend=vi.fn<typeof fetch>(async url=>String(url).endsWith('/capabilities')?json(capabilities(endpoint('client','update'))):json(updateReceipt('client',clientId)));
    const legacy=await sendProjectAlphaDirectoryProfileUpdate(connection,'client',clientId,command,legacySend);
    expect(legacy).toMatchObject({status:'acknowledged'});expect(validatedProjectAlphaDirectoryClientContactProfileAcknowledgement(legacy)).toBeNull();
  });

  it('checks the configured exact neutral descriptor without rejecting unrelated future routes',async()=>{
    const caps=capabilities(neutral);caps.implementedEndpoints.push({method:'POST',path:'/api/v2/future/unknown',requiredCapability:'future.write'});
    const send=vi.fn<typeof fetch>(async url=>{expect(String(url)).toBe(`${connection.baseUrl}/api/v2/capabilities`);return json(caps);});
    expect(await probeConfiguredProjectAlphaDirectoryClientContactProfile(env,sourceId,send)).toMatchObject({status:'verified',sourceInstanceId:source,applicationId:application,historyEpoch:epoch});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['legacy-only',()=>capabilities(endpoint('client','update'))],
    ['missing revision guard',()=>capabilities({...neutral,requiresExpectedRevision:false})],
    ['missing source guard',()=>capabilities({...neutral,requiresSourceInstanceId:false})],
    ['missing application guard',()=>capabilities({...neutral,requiresApplicationId:false})],
    ['missing history guard',()=>capabilities({...neutral,requiresHistoryEpoch:false})],
    ['wrong method',()=>capabilities({...neutral,method:'PATCH'})],
    ['write scope absent',()=>({...capabilities(neutral),grantedCapabilities:[{name:'api.capabilities.read'}]})],
    ['foreign source',()=>({...capabilities(neutral),sourceInstanceId:commandId})],
    ['foreign application',()=>({...capabilities(neutral),applicationId:commandId})],
    ['foreign history',()=>({...capabilities(neutral),historyEpoch:commandId})],
  ])('does not POST or fall back when %s',async(_label,make)=>{
    const send=vi.fn<typeof fetch>(async()=>json(make()));
    expect(await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,command,send)).toMatchObject({status:'blocked',reason:'preflight'});
    expect(send).toHaveBeenCalledTimes(1);expect(String(send.mock.calls[0]![0])).toContain('/capabilities');
  });

  it.each([
    ['foreign source',()=>json({...updateReceipt('client',clientId),sourceInstanceId:commandId})],
    ['foreign application',()=>json({...updateReceipt('client',clientId),applicationId:commandId})],
    ['foreign epoch',()=>json({...updateReceipt('client',clientId),historyEpoch:commandId})],
    ['wrong public ID',()=>json(updateReceipt('client',organizationId))],
    ['regressed revision',()=>json(updateReceipt('client',clientId,'0'))],
    ['wrong authorization generation',()=>json(updateReceipt('client',clientId,'2','8'))],
    ['foreign redirect',()=>json(updateReceipt('client',clientId),302,{Location:'https://foreign.example.test/steal'})],
    ['cookie response',()=>json(updateReceipt('client',clientId),200,{'Set-Cookie':'forbidden=1'})],
    ['malformed result',()=>new Response('{',{headers:json({}).headers})],
  ])('keeps an unknown write outcome uncertain for %s',async(_label,make)=>{
    const send=vi.fn<typeof fetch>(async url=>String(url).endsWith('/capabilities')?json(capabilities(neutral)):make());
    const result=await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,command,send);
    expect(result).toMatchObject({status:'uncertain',reason:'invalid_contract'});expect(validatedProjectAlphaDirectoryClientContactProfileAcknowledgement(result)).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([[409,'conflict'],[403,'blocked'],[400,'rejected'],[503,'uncertain']] as const)('classifies HTTP %i as %s',async(status,classification)=>{
    const send=vi.fn<typeof fetch>(async url=>String(url).endsWith('/capabilities')?json(capabilities(neutral)):json({},status));
    expect(await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,command,send)).toMatchObject({status:classification,reason:'http_status',httpStatus:status});
  });

  it('rejects foreign configuration, malformed public IDs/CAS fields, and disabled deployments without sending credentials',async()=>{
    const send=vi.fn<typeof fetch>();
    expect(await sendProjectAlphaDirectoryClientContactProfileUpdate({...connection,baseUrl:'https://source-a.example.test/path'},clientId,command,send)).toMatchObject({status:'blocked',reason:'preflight'});
    expect(await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,'../foreign',command,send)).toEqual({status:'rejected',reason:'invalid_command'});
    expect(await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,{...command,expectedRevision:'0'},send)).toEqual({status:'rejected',reason:'invalid_command'});
    expect(await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,{...command,expectedAuthorizationGeneration:'-1'},send)).toEqual({status:'rejected',reason:'invalid_command'});
    const disabled={PROJECT_ALPHA_API_V2_CONNECTIONS:env.PROJECT_ALPHA_API_V2_CONNECTIONS.replace('"enabled":true','"enabled":false')};
    expect(await probeConfiguredProjectAlphaDirectoryClientContactProfile(disabled,sourceId,send)).toEqual({status:'disabled',sourceId});
    expect(await sendConfiguredProjectAlphaDirectoryClientContactProfileUpdate(disabled,sourceId,clientId,command,send)).toEqual({status:'disabled',sourceId});
    expect(send).not.toHaveBeenCalled();
  });

  it('retains transport failures as uncertain so the caller can retry the original persisted command',async()=>{
    const send=vi.fn<typeof fetch>(async url=>{if(String(url).endsWith('/capabilities'))return json(capabilities(neutral));throw Error('upstream transport-secret failure');});
    const result=await sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,command,send);
    expect(result).toEqual({status:'uncertain',reason:'transport'});expect(JSON.stringify(result)).not.toContain('transport-secret');
  });

  it('bounds a stalled neutral acknowledgement body and cancels it without claiming success',async()=>{
    vi.useFakeTimers();let cancelled=false;
    try{const send=vi.fn<typeof fetch>(async url=>String(url).endsWith('/capabilities')?json(capabilities(neutral)):
      new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:json({}).headers}));
      const pending=sendProjectAlphaDirectoryClientContactProfileUpdate(connection,clientId,command,send);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({status:'uncertain',reason:'timeout'});expect(cancelled).toBe(true);
    }finally{vi.useRealTimers();}
  });
});
