import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { fixture, id, principal } from "./helpers/windows-portal-successor-fixture";
import { encodeWindowsPortalCatalogHandle as encode, decodeWindowsPortalCatalogHandle as decode,
  windowsPortalCatalogHandleMatchesContext as matches, type WindowsPortalCatalogSelector } from "../src/worker/client-portal/windows-portal-catalog-handles";
import type { WindowsPortalCatalogContext } from "../src/worker/client-portal/windows-portal-catalog-authorization";
import { decodeWindowsPortalSuccessorHandle } from "../src/worker/client-portal/windows-portal-successor-handles";
import { decodeOperationsNativeDeliveryHandle } from "../src/worker/client-portal/operations-native-delivery-handles";
const env={DELIVERY_SESSION_SECRET:"synthetic-catalog-secret-".repeat(3), DELIVERY_PREVIOUS_SESSION_SECRET:undefined};
const file:WindowsPortalCatalogSelector={kind:"file",path:"photos/map.tif",indexedETag:'"index-etag"',size:52750};
const folder:WindowsPortalCatalogSelector={kind:"folder",path:"photos/"};
async function setup(selected:WindowsPortalCatalogSelector=file) {
  const f=await fixture() as Mutable<Awaited<ReturnType<typeof fixture>>>, feature=selected.kind==="file" ? "file.metadata" : "folder.list";
  f.command.features=[feature]; const fingerprint=await sha256OperationsPortalNativeDeliveryAuthorityCommand(f.command);
  const context:WindowsPortalCatalogContext={kind:"windows-portal-catalog-v1",feature,originalGrant:f.command,
    originalRequestFingerprint:fingerprint,selectedR2Prefix:f.command.resource.selectedR2Prefix,
    continuity:{...f.successor.continuity,grantFingerprint:fingerprint}};
  const until=Date.now()+600_000;
  const token=await encode(env,context,principal,until,selected),handle=(await decode(env,token))!;
  expect(handle).not.toBeNull(); return {context,until,token,handle};
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const clone=<T>(v:T):Mutable<T>=>JSON.parse(JSON.stringify(v)) as Mutable<T>;
afterEach(()=>vi.useRealTimers());
describe("private Windows catalog selectors",()=>{
  it.each([file,folder,{kind:"folder",path:""},{kind:"cursor",scope:"folder",path:"photos/",after:"map.tif",entryKind:"file"},
    {kind:"cursor",scope:"deliveries",path:"",after:id(2),entryKind:"delivery"}] as WindowsPortalCatalogSelector[])("round-trips only metadata selectors %j",async selected=>{
    const f=await setup(selected); expect(f.token).toMatch(/^wpc1_[A-Za-z0-9_-]+$/u);
    expect(f.handle).toMatchObject({...selected,originalGrantFingerprint:f.context.originalRequestFingerprint,...principal,current:f.context.continuity.current});
    expect(f.handle).not.toHaveProperty("selectedR2Prefix");expect(f.handle).not.toHaveProperty("providerVersion");expect(f.handle).not.toHaveProperty("sha256");
    expect(Object.isFrozen(f.handle)).toBe(true);expect(Object.isFrozen(f.handle.current)).toBe(true);
    expect(await matches(f.handle,f.context,principal,f.until)).toBe(true);
  });
  it("caps TTL by human/grant expiry and rejects expiry or shortened human session",async()=>{
    vi.useFakeTimers();vi.setSystemTime(Date.now());const f=await setup();
    expect(f.handle.expires).toBe(f.until);expect(await matches(f.handle,f.context,principal,f.until-1)).toBe(false);
    const long=(await decode(env,await encode(env,f.context,principal,Date.now()+3_600_000,file)))!;
    expect(long.expires).toBe(Date.now()+900_000);
    const c=clone(f.context);c.originalGrant.expiresAt=new Date(Date.now()+120_000).toISOString();
    c.originalRequestFingerprint=await sha256OperationsPortalNativeDeliveryAuthorityCommand(c.originalGrant);c.continuity.grantFingerprint=c.originalRequestFingerprint;
    expect((await decode(env,await encode(env,c,principal,f.until,file)))!.expires).toBe(Date.parse(c.originalGrant.expiresAt));
    vi.setSystemTime(f.until+1);expect(await decode(env,f.token)).toBeNull();expect(await matches(f.handle,f.context,principal,f.until)).toBe(false);
  });
  it("separates encryption purposes and supports previous-key rotation",async()=>{
    const f=await setup(),rotated={DELIVERY_SESSION_SECRET:"rotated-synthetic-key-".repeat(3),DELIVERY_PREVIOUS_SESSION_SECRET:env.DELIVERY_SESSION_SECRET};
    expect(await decode(rotated,f.token)).toEqual(f.handle);expect(await decode({DELIVERY_SESSION_SECRET:rotated.DELIVERY_SESSION_SECRET},f.token)).toBeNull();
    expect(await decodeWindowsPortalSuccessorHandle(env,f.token)).toBeNull();expect(await decodeOperationsNativeDeliveryHandle(env,f.token)).toBeNull();
    expect(await decodeWindowsPortalSuccessorHandle(env,"wsp1_"+f.token.slice(5))).toBeNull();
    expect(await decode(env,f.token+"=")).toBeNull();expect(await decode(env,"wpc1_"+"a".repeat(8192))).toBeNull();
    expect(await decode(env,f.token.slice(0,20)+(f.token[20]==="a"?"b":"a")+f.token.slice(21))).toBeNull();
  });
  it.each(["authorityId","originalGrantFingerprint","issuer","subject","chainSha256","publicationCount"] as const)("rejects changed binding %s",async field=>{
    const f=await setup(),h=clone(f.handle);
    if(field==="authorityId")h[field]=id(900);else if(field==="publicationCount")h[field]++;else h[field]="e".repeat(64);
    expect(await matches(h,f.context,principal,f.until)).toBe(false);
  });
  it.each(["operationId","publicationId","revision","sourceSequence","snapshotId","snapshotSha256"] as const)("rejects stale publication %s",async field=>{
    const f=await setup({kind:"cursor",scope:"folder",path:"photos/",after:"map.tif",entryKind:"file"}),h=clone(f.handle);
    if(field==="revision"||field==="sourceSequence")h.current[field]++;else h.current[field]=field==="snapshotSha256"?"e".repeat(64):id(900);
    expect(await matches(h,f.context,principal,f.until)).toBe(false);
  });
  it("requires exact selector feature and complete original lifecycle fingerprint",async()=>{
    const f=await setup();await expect(encode(env,f.context,principal,f.until,folder)).rejects.toThrow();
    const c=clone(f.context);c.feature="folder.list";expect(await matches(f.handle,c,principal,f.until)).toBe(false);
    const c2=clone(f.context);c2.originalGrant.recipient.homeOwnershipEpoch="2";
    c2.originalRequestFingerprint=await sha256OperationsPortalNativeDeliveryAuthorityCommand(c2.originalGrant);c2.continuity.grantFingerprint=c2.originalRequestFingerprint;
    expect(await matches(f.handle,c2,principal,f.until)).toBe(false);
  });
  it.each([
    {...file,path:"../secret"},{...file,path:"photos/"},{...file,path:"_ltds/secret"},{...file,path:"/absolute"},
    {...file,path:"photos\\secret"},{...file,size:-1},{...file,indexedETag:""},{...file,providerVersion:"forbidden"},
    {kind:"folder",path:"photos"},{kind:"folder",path:"photos//"},
    {kind:"cursor",scope:"deliveries",path:"photos/",after:id(2),entryKind:"delivery"},
    {kind:"cursor",scope:"folder",path:"",after:"../file",entryKind:"file"},
    {kind:"cursor",scope:"folder",path:"",after:"file",entryKind:"delivery"},
  ])("rejects malformed selector %j",async selected=>{
    const f=await setup();await expect(encode(env,f.context,principal,f.until,selected as WindowsPortalCatalogSelector)).rejects.toThrow();
  });
  it("snapshots nested context and selector before cryptographic awaits",async()=>{
    const f=await setup(),context=clone(f.context),selected=clone(file),person={...principal};
    const expected=canonicalOperationsPortalNativeDeliveryAuthorityCommand(context.originalGrant);
    const pending=encode(env,context,person,f.until,selected);
    context.originalGrant.recipient.homeOwnershipEpoch="2";context.continuity.current.snapshotSha256="e".repeat(64);person.subject="mutated";
    if(selected.kind==="file")selected.path="other.tif";
    const h=(await decode(env,await pending))!;expect(h.subject).toBe(principal.subject);expect(h.kind==="file"&&h.path).toBe(file.path);
    expect(h.originalGrantFingerprint).toBe(f.context.originalRequestFingerprint);expect(expected).not.toBe(canonicalOperationsPortalNativeDeliveryAuthorityCommand(context.originalGrant));
  });
});
