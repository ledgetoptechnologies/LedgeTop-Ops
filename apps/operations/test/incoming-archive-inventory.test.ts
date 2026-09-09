import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listArchiveInventory, recordArchiveInventory } from "../src/worker/incoming-archive-inventory";

let runtime: Miniflare, db: D1Database;
const token="11111111-1111-4111-8111-111111111111", inventoryId="22222222-2222-4222-8222-222222222222";
const env = () => ({ DELIVERY_DB: db, INCOMING_BUCKET: { head: async () => ({ size: 9, etag: "abcdef", version: "v1" }) } });
const proof={claimToken:token,sha256:"a".repeat(64),objectEtag:"abcdef",objectBytes:9,objectVersion:"v1",inventoryId};
describe("incoming archive inventory",()=>{
  beforeAll(async()=>{runtime=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:"archive-inventory"}});db=await runtime.getD1Database("DB") as unknown as D1Database;for(const n of ["0090_aliases_incoming_requests.sql","0093_reusable_incoming_uploads.sql","0116_incoming_upload_hardening.sql","0198_incoming_upload_owner_notifications.sql","0199_incoming_upload_pickup_lifecycle.sql","0211_incoming_upload_verification_lifecycle.sql","0212_incoming_upload_archive_inventory.sql"]){const s=readFileSync(new URL(`../../client/migrations/${n}`,import.meta.url),"utf8").replace(/^\s*--.*$/gm,"").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i,"");await db.exec(s.replace(/\s*\n\s*/g," "));}});
  beforeEach(async()=>{await db.exec("DELETE FROM file_request_upload_archive_inventory_entries; DELETE FROM file_request_upload_archive_inventory_pages; DELETE FROM file_request_upload_archive_inventory; DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM file_requests;");await db.batch([db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('r','p','t','s',datetime('now','+1 day'),1,99,1)"),db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('c','r','c','c@x','h')"),db.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,verification_state,verified_sha256,verified_object_etag,verified_object_bytes,verified_object_version,verification_receipt_token) VALUES('u','r','c','quarantine/r/u/object','m','archive.zip',9,9,'application/zip','quarantined','verified',?,?,?,?,?)`).bind("a".repeat(64),"abcdef",9,"v1",token)]);});
  afterAll(async()=>runtime.dispose());
  it("rejects Windows drive paths before staging metadata", async () => {
    for (const path of ["C:/private.txt", "C:private.txt"]) {
      await expect(recordArchiveInventory(env() as never, "u", {
        ...proof, page: 0, complete: true,
        entries: [{ path, name: path.split("/").at(-1)!, kind: "file", size: 0 }],
      })).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.prepare("SELECT COUNT(*) count FROM file_request_upload_archive_inventory").first()).toEqual({ count: 0 });
  });
  it("retires only the superseded generation during replacement", async () => {
    await recordArchiveInventory(env() as never, "u", { ...proof, page: 0, complete: true, entries: [{ path: "old", name: "old", kind: "file", size: 0 }] });
    const nextToken = "33333333-3333-4333-8333-333333333333", nextId = "44444444-4444-4444-8444-444444444444";
    await db.prepare("UPDATE file_request_uploads SET verification_receipt_token=?,verified_sha256=? WHERE id='u'").bind(nextToken, "b".repeat(64)).run();
    // Simulate replacement-generation metadata arriving between parent removal
    // and cleanup. Cleanup must not erase a different inventory generation.
    await db.prepare("INSERT INTO file_request_upload_archive_inventory_entries(upload_id,inventory_id,path,parent_path,name,name_folded,kind,size) VALUES('u',?,'survivor','','survivor','survivor','file',0)").bind(nextId).run();
    await recordArchiveInventory(env() as never, "u", { ...proof, claimToken: nextToken, sha256: "b".repeat(64), inventoryId: nextId, page: 0, complete: true, entries: [] });
    const rows = await db.prepare("SELECT inventory_id inventoryId,path FROM file_request_upload_archive_inventory_entries WHERE upload_id='u'").all();
    expect(rows.results).toEqual([{ inventoryId: nextId, path: "survivor" }]);
  });
  it("keeps pagination cursors bounded for deep Unicode folders", async () => {
    const segments = Array.from({ length: 4 }, (_, index) => `${"界".repeat(80)}${index}`);
    const path = segments.join("/");
    const folders = segments.map((name, index) => ({ path: segments.slice(0, index + 1).join("/"), name, kind: "folder" as const }));
    const files = Array.from({ length: 101 }, (_, index) => ({ path: `${path}/${index.toString().padStart(3, "0")}.txt`, name: `${index.toString().padStart(3, "0")}.txt`, kind: "file" as const, size: 0 }));
    await recordArchiveInventory(env() as never, "u", { ...proof, page: 0, complete: true, entries: [...folders, ...files] });
    const first = await listArchiveInventory(env() as never, "u", path, "", null);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor!.length).toBeLessThan(2048);
    const second = await listArchiveInventory(env() as never, "u", path, "", first.nextCursor);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.name).toBe("100.txt");
  });
  it("pages Unicode entries without skips and treats search wildcards literally", async () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({ path: `文${String(index).padStart(3, "0")}.txt`, name: `文${String(index).padStart(3, "0")}.txt`, kind: "file" as const, size: 0 }));
    entries.push({ path: "literal%.txt", name: "literal%.txt", kind: "file", size: 0 });
    await recordArchiveInventory(env() as never, "u", { ...proof, page: 0, complete: true, entries });
    const first = await listArchiveInventory(env() as never, "u", "", "文", null);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await listArchiveInventory(env() as never, "u", "", "文", first.nextCursor);
    const third = await listArchiveInventory(env() as never, "u", "", "文", second.nextCursor);
    expect(second.items).toHaveLength(100); expect(third.items).toHaveLength(5); expect(third.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.path)).size).toBe(205);
    await expect(listArchiveInventory(env() as never, "u", "", "different", first.nextCursor)).rejects.toMatchObject({ status: 400 });
    const literal = await listArchiveInventory(env() as never, "u", "", "%", null);
    expect(literal.items.map(item => item.name)).toEqual(["literal%.txt"]);
  });
  it("stores sequential exact-proof pages idempotently and lists bounded metadata",async()=>{const page={...proof,page:0,complete:true,entries:[{path:"folder",name:"folder",kind:"folder" as const},{path:"folder/empty.txt",name:"empty.txt",kind:"file" as const,size:0}]};expect(await recordArchiveInventory(env() as never,"u",page)).toMatchObject({status:"ready"});expect(await recordArchiveInventory(env() as never,"u",page)).toMatchObject({replayed:true});expect(await listArchiveInventory(env() as never,"u","folder",null,null)).toEqual({status:"ready",items:[{path:"folder/empty.txt",name:"empty.txt",kind:"file",size:0}],nextCursor:null});});
  it("rejects stale proof and invalid paths without exposing inventory",async()=>{await expect(recordArchiveInventory(env() as never,"u",{...proof,sha256:"b".repeat(64),page:0,complete:true,entries:[]})).rejects.toMatchObject({status:409});await expect(recordArchiveInventory(env() as never,"u",{...proof,page:0,complete:true,entries:[{path:"../x",name:"x",kind:"file",size:0}]})).rejects.toMatchObject({status:400});expect(await listArchiveInventory(env() as never,"u",null,null,null)).toEqual({status:"unavailable",items:[],nextCursor:null});});
  it("fences competing pages against accepted state and conflicting replays",async()=>{const first={...proof,page:0,complete:false,entries:[{path:"one",name:"one",kind:"file" as const,size:0}]};await recordArchiveInventory(env() as never,"u",first);await expect(recordArchiveInventory(env() as never,"u",{...first,entries:[{path:"other",name:"other",kind:"file",size:0}]})).rejects.toMatchObject({status:409});await db.prepare("UPDATE file_request_uploads SET status='accepted' WHERE id='u'").run();await expect(recordArchiveInventory(env() as never,"u",{...proof,page:1,complete:true,entries:[{path:"two",name:"two",kind:"file",size:0}]})).rejects.toMatchObject({status:409});const rows=await db.prepare("SELECT path FROM file_request_upload_archive_inventory_entries WHERE upload_id='u' ORDER BY path").all();expect(rows.results).toEqual([{path:"one"}]);});
  it("derives optional object version from the verified row and replaces superseded proof",async()=>{const {objectVersion:_ignored,...omitted}=proof;await recordArchiveInventory(env() as never,"u",{...omitted,page:0,complete:true,entries:[{path:"ü.txt",name:"ü.txt",kind:"file",size:0}]});expect((await listArchiveInventory(env() as never,"u",null,null,null)).status).toBe("ready");const nextToken="33333333-3333-4333-8333-333333333333",nextId="44444444-4444-4444-8444-444444444444";await db.prepare("UPDATE file_request_uploads SET verification_receipt_token=?,verified_sha256=? WHERE id='u'").bind(nextToken,"b".repeat(64)).run();await expect(recordArchiveInventory(env() as never,"u",{...proof,page:0,complete:true,entries:[]})).rejects.toMatchObject({status:409});await recordArchiveInventory(env() as never,"u",{...proof,claimToken:nextToken,sha256:"b".repeat(64),inventoryId:nextId,page:0,complete:true,entries:[]});const current=await db.prepare("SELECT inventory_id inventoryId FROM file_request_upload_archive_inventory WHERE upload_id='u'").bind().first<{inventoryId:string}>();expect(current?.inventoryId).toBe(nextId);});
  it("never stages an inventory for another matching verified upload",async()=>{await db.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,verification_state,verified_sha256,verified_object_etag,verified_object_bytes,verified_object_version,verification_receipt_token) VALUES('u2','r','c','quarantine/r/u2/object','m2','other.zip',9,9,'application/zip','quarantined','verified',?,?,?,?,?)`).bind("a".repeat(64),"abcdef",9,"v1",token).run();await recordArchiveInventory(env() as never,"u",{...proof,page:0,complete:true,entries:[]});const rows=await db.prepare("SELECT upload_id uploadId FROM file_request_upload_archive_inventory ORDER BY upload_id").all<{uploadId:string}>();expect(rows.results).toEqual([{uploadId:"u"}]);});
});
