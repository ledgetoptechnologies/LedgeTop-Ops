import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryBrowseRevision, listDeliveryFolder } from "../src/worker/delivery";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal:StaffPrincipal={
  id:"staff-a",email:"staff@example.test",displayName:"Staff",accessSubject:"subject-a",projectAlphaUserId:null,
};

async function applySql(db:D1Database,sql:string):Promise<void>{
  for(const statement of sql.split(/;\s*(?:\n|$)/).map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
}

function r2Object(key:string):R2Object{
  return {
    key,version:"version-a",size:1024,etag:"etag-a",httpEtag:'"etag-a"',uploaded:new Date("2026-08-07T12:00:00.000Z"),
    storageClass:"Standard",checksums:{toJSON:()=>({})},httpMetadata:{contentType:"image/jpeg"},customMetadata:{},
    writeHttpMetadata:()=>undefined,
  } as unknown as R2Object;
}

describe("Delivery folder-only listing performance",()=>{
  let miniflare:Miniflare;
  let opsDb:D1Database;
  let deliveryDb:D1Database;
  let grantQueries:string[];
  let deliveryQueries:string[];
  let list:ReturnType<typeof vi.fn>;
  let head:ReturnType<typeof vi.fn>;
  let get:ReturnType<typeof vi.fn>;

  beforeAll(async()=>{
    miniflare=new Miniflare({
      compatibilityDate:"2026-07-22",modules:true,script:"export default { fetch() { return new Response('ok'); } };",
      d1Databases:{OPS_DB:"delivery-folder-performance-ops",DELIVERY_DB:"delivery-folder-performance-delivery"},
    });
    opsDb=(await miniflare.getD1Database("OPS_DB")) as unknown as D1Database;
    deliveryDb=(await miniflare.getD1Database("DELIVERY_DB")) as unknown as D1Database;
    await applySql(opsDb,`CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL);
      CREATE TABLE staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT NOT NULL,permission_key TEXT NOT NULL,effect TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
      CREATE TABLE project_folders(project_id TEXT PRIMARY KEY,division_id TEXT NOT NULL,r2_prefix TEXT NOT NULL);
      CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT);`);
    await applySql(deliveryDb,`CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,content_type TEXT,media_kind TEXT NOT NULL);
      CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,deleted_by TEXT,deleted_at TEXT,purge_after TEXT,restored_by TEXT,restored_at TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,r2_prefix TEXT NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE shares(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,r2_prefix TEXT,revoked_at TEXT,expires_at TEXT);
      CREATE TABLE file_aliases(physical_key TEXT PRIMARY KEY,display_name TEXT NOT NULL);`);
  });

  beforeEach(async()=>{
    grantQueries=[];deliveryQueries=[];list=vi.fn();head=vi.fn();get=vi.fn();
    await opsDb.batch([
      opsDb.prepare("DELETE FROM staff_permission_overrides"),opsDb.prepare("DELETE FROM staff_role_assignments"),
      opsDb.prepare("DELETE FROM local_staff_role_assignments"),opsDb.prepare("DELETE FROM role_permissions"),
      opsDb.prepare("DELETE FROM project_folders"),opsDb.prepare("DELETE FROM pa_projects"),
      opsDb.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('delivery-role','delivery.browse')"),
      opsDb.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope,division_id) VALUES('staff-a','delivery-role','global',NULL)"),
    ]);
    await deliveryDb.batch([
      deliveryDb.prepare("DELETE FROM file_aliases"),deliveryDb.prepare("DELETE FROM shares"),deliveryDb.prepare("DELETE FROM projects"),
      deliveryDb.prepare("DELETE FROM delivery_tombstones"),deliveryDb.prepare("DELETE FROM file_index"),
    ]);
  });

  afterAll(async()=>miniflare.dispose());

  function environment():Env{
    const trackedOps={prepare(sql:string){if(sql.includes("SELECT rp.permission_key"))grantQueries.push(sql);return opsDb.prepare(sql);}};
    return {
      OPS_DB:{withSession(){return trackedOps;},prepare(sql:string){return opsDb.prepare(sql);}},
      DELIVERY_DB:{prepare(sql:string){deliveryQueries.push(sql);return deliveryDb.prepare(sql);}},
      DATA_BUCKET:{list,head,get},
    } as unknown as Env;
  }

  it("changes the server-issued cache revision when effective folder scope changes without reading R2",async()=>{
    const env=environment();
    const globalRevision=await deliveryBrowseRevision(env,principal);
    expect(globalRevision).toMatch(/^dbr_[A-Za-z0-9_-]{43}$/);
    await opsDb.batch([
      opsDb.prepare("DELETE FROM staff_role_assignments"),
      opsDb.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope,division_id) VALUES('staff-a','delivery-role','division','division-a')"),
      opsDb.prepare("INSERT INTO pa_projects(id,name) VALUES('project-a','Project A')"),
      opsDb.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix) VALUES('project-a','division-a','Jobs/Clients/Scoped/')"),
    ]);
    const scopedRevision=await deliveryBrowseRevision(env,principal);
    expect(scopedRevision).toMatch(/^dbr_[A-Za-z0-9_-]{43}$/);
    expect(scopedRevision).not.toBe(globalRevision);
    expect(list).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("uses one R2 metadata listing for 120 indexed child folders and never reads files or thumbnails",async()=>{
    const folders=Array.from({length:120},(_,index)=>`Jobs/Clients/Client-${String(index).padStart(3,"0")}/`);
    for(let offset=0;offset<folders.length;offset+=75){
      await deliveryDb.batch(folders.slice(offset,offset+75).map((folder,index)=>deliveryDb.prepare(
        "INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')",
      ).bind(`${folder}photo-${offset+index}.jpg`,`etag-${offset+index}`,1024,"2026-08-07T12:00:00.000Z","image/jpeg")));
    }
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO file_aliases(physical_key,display_name) VALUES(?,?)").bind(folders[0],"First client"),
      deliveryDb.prepare("INSERT INTO file_aliases(physical_key,display_name) VALUES(?,?)").bind(folders.at(-1),"Last client"),
    ]);
    list.mockImplementation(async(options:R2ListOptions)=>{
      if(options.prefix!=="Jobs/Clients/")throw new Error("unexpected recursive R2 listing");
      return {objects:[],delimitedPrefixes:folders,truncated:false};
    });

    const started=performance.now();
    const result=await listDeliveryFolder(environment(),principal,"Jobs/Clients/");
    const elapsedMs=performance.now()-started;

    expect(result.folders).toHaveLength(120);
    expect(result.folders[0]?.name).toBe("First client");
    expect(result.folders.at(-1)?.name).toBe("Last client");
    expect(result.files).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({prefix:"Jobs/Clients/",delimiter:"/",limit:500,cursor:undefined,include:["httpMetadata","customMetadata"]});
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(grantQueries).toHaveLength(2);
    expect(deliveryQueries.filter(sql=>sql.includes("WITH candidates(prefix,upper_bound)")).length).toBe(3);
    expect(deliveryQueries.filter(sql=>sql.includes("FROM file_aliases WHERE physical_key IN")).length).toBe(2);
    expect(deliveryQueries.some(sql=>sql.includes("image_thumbnail_jobs"))).toBe(false);
    expect(elapsedMs).toBeLessThan(1500);
  },15_000);

  it("lists the true Jobs root with one delimiter query and no recursive object or thumbnail reads",async()=>{
    const folders=["Jobs/Archive/","Jobs/Clients/","Jobs/Demo/"];
    await deliveryDb.batch(folders.map((folder,index)=>deliveryDb.prepare(
      "INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')",
    ).bind(`${folder}photo-${index}.jpg`,`root-etag-${index}`,1024,"2026-08-07T12:00:00.000Z","image/jpeg")));
    list.mockResolvedValue({objects:[],delimitedPrefixes:folders,truncated:false});

    const started=performance.now();
    const result=await listDeliveryFolder(environment(),principal,"Jobs/");
    const elapsedMs=performance.now()-started;

    expect(result.folders.map(folder=>folder.prefix)).toEqual(folders);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({prefix:"Jobs/",delimiter:"/",limit:500,cursor:undefined,include:["httpMetadata","customMetadata"]});
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deliveryQueries.some(sql=>sql.includes("image_thumbnail_jobs"))).toBe(false);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("forwards the opaque R2 cursor and returns only the next authorized folder page",async()=>{
    const folder="Jobs/Clients/Page-Two/";
    await deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')")
      .bind(`${folder}photo.jpg`,"etag-page-two",1024,"2026-08-07T12:00:00.000Z","image/jpeg").run();
    list.mockResolvedValue({objects:[],delimitedPrefixes:[folder],truncated:true,cursor:"opaque-next-cursor"});

    const result=await listDeliveryFolder(environment(),principal,"Jobs/Clients/","opaque-current-cursor");

    expect(result.folders.map(value=>value.prefix)).toEqual([folder]);
    expect(result.files).toEqual([]);
    expect(result.nextCursor).toBe("opaque-next-cursor");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      prefix:"Jobs/Clients/",delimiter:"/",limit:500,cursor:"opaque-current-cursor",include:["httpMetadata","customMetadata"],
    });
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back only for unindexed candidates and keeps hidden or trashed-only folders out",async()=>{
    const indexed="Jobs/Clients/Indexed/",fresh="Jobs/Clients/Fresh/",trashedOnly="Jobs/Clients/Trashed/";
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')")
        .bind(`${indexed}photo.jpg`,"etag-indexed",1024,"2026-08-07T12:00:00.000Z","image/jpeg"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')")
        .bind(`${trashedOnly}photo.jpg`,"etag-trashed",1024,"2026-08-07T12:00:00.000Z","image/jpeg"),
      deliveryDb.prepare("INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,restored_at) VALUES('trash-a',?,'exact',NULL)")
        .bind(`${trashedOnly}photo.jpg`),
    ]);
    list.mockImplementation(async(options:R2ListOptions)=>{
      if(options.prefix==="Jobs/Clients/")return {objects:[],delimitedPrefixes:[indexed,fresh,trashedOnly],truncated:false};
      if(options.prefix===fresh)return {objects:[r2Object(`${fresh}new.jpg`)],delimitedPrefixes:[],truncated:false};
      if(options.prefix===trashedOnly)return {objects:[r2Object(`${trashedOnly}photo.jpg`)],delimitedPrefixes:[],truncated:false};
      throw new Error("unexpected listing");
    });

    const result=await listDeliveryFolder(environment(),principal,"Jobs/Clients/");

    expect(result.folders.map(folder=>folder.prefix)).toEqual([indexed,fresh]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.map(call=>(call[0] as R2ListOptions).prefix)).toEqual(["Jobs/Clients/",fresh,trashedOnly]);
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("denies revoked global browse access before any R2 or folder-index query",async()=>{
    await opsDb.prepare("INSERT INTO staff_permission_overrides(staff_id,permission_key,effect,scope,division_id) VALUES('staff-a','delivery.browse','deny','global',NULL)").run();
    await expect(listDeliveryFolder(environment(),principal,"Jobs/Clients/")).rejects.toMatchObject({status:403});
    expect(list).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deliveryQueries).toEqual([]);
  });

  it("denies a division-scoped principal at the true Jobs root before R2 enumeration",async()=>{
    await opsDb.batch([
      opsDb.prepare("DELETE FROM staff_role_assignments WHERE staff_id='staff-a'"),
      opsDb.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope,division_id) VALUES('staff-a','delivery-role','division','division-a')"),
      opsDb.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix) VALUES('project-a','division-a','Jobs/Clients/Acme/')"),
      opsDb.prepare("INSERT INTO pa_projects(id,name) VALUES('project-a','Acme')"),
    ]);

    await expect(listDeliveryFolder(environment(),principal,"Jobs/")).rejects.toMatchObject({status:404});
    expect(list).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deliveryQueries).toEqual([]);
  });
});
