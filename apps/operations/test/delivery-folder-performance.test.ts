import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_FOLDER_PAGE_SIZE, deliveryBrowseRevision, listDeliveryFolder, listDeliveryFolderMedia, searchDeliveryItems } from "../src/worker/delivery";
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
    await applySql(deliveryDb,`CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,content_type TEXT,media_kind TEXT NOT NULL,stream_uid TEXT,stream_status TEXT);
      CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,deleted_by TEXT,deleted_at TEXT,purge_after TEXT,restored_by TEXT,restored_at TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,r2_prefix TEXT NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE shares(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,r2_prefix TEXT,revoked_at TEXT,expires_at TEXT);
      CREATE TABLE file_aliases(physical_key TEXT PRIMARY KEY,display_name TEXT NOT NULL);
      CREATE TABLE image_thumbnail_jobs(source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL,thumbnail_key TEXT NOT NULL,
        thumbnail_etag TEXT,thumbnail_size INTEGER,status TEXT NOT NULL,error_code TEXT);`);
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
      deliveryDb.prepare("DELETE FROM delivery_tombstones"),deliveryDb.prepare("DELETE FROM file_index"),deliveryDb.prepare("DELETE FROM image_thumbnail_jobs"),
    ]);
  });

  afterAll(async()=>miniflare.dispose());

  function environment():Env{
    const trackedOps={prepare(sql:string){if(sql.includes("SELECT rp.permission_key"))grantQueries.push(sql);return opsDb.prepare(sql);}};
    return {
      OPS_DB:{withSession(){return trackedOps;},prepare(sql:string){return opsDb.prepare(sql);}},
      DELIVERY_DB:{prepare(sql:string){deliveryQueries.push(sql);return deliveryDb.prepare(sql);},batch(statements:D1PreparedStatement[]){return deliveryDb.batch(statements);}},
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

  it("uses one R2 metadata listing for 120 indexed child folders and no per-item reads",async()=>{
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
    expect(list).toHaveBeenCalledWith({prefix:"Jobs/Clients/",delimiter:"/",limit:DELIVERY_FOLDER_PAGE_SIZE,cursor:undefined,include:["httpMetadata","customMetadata"]});
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(grantQueries).toHaveLength(2);
    expect(deliveryQueries.filter(sql=>sql.includes("WITH candidates(prefix,upper_bound)")).length).toBe(3);
    expect(deliveryQueries.filter(sql=>sql.includes("FROM file_aliases WHERE physical_key IN")).length).toBe(2);
    expect(deliveryQueries.some(sql=>sql.includes("WHERE source_key=?"))).toBe(false);
    expect(elapsedMs).toBeLessThan(10_000);
  },15_000);

  it("lists the true Jobs root with one delimiter query and no recursive object reads",async()=>{
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
    expect(list).toHaveBeenCalledWith({prefix:"Jobs/",delimiter:"/",limit:DELIVERY_FOLDER_PAGE_SIZE,cursor:undefined,include:["httpMetadata","customMetadata"]});
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deliveryQueries.some(sql=>sql.includes("WHERE source_key=?"))).toBe(false);
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
      prefix:"Jobs/Clients/",delimiter:"/",limit:DELIVERY_FOLDER_PAGE_SIZE,cursor:"opaque-current-cursor",include:["httpMetadata","customMetadata"],
    });
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("fails unindexed candidates closed and signals reconciliation without recursive R2 scans",async()=>{
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
      throw new Error("unexpected listing");
    });

    const result=await listDeliveryFolder(environment(),principal,"Jobs/Clients/");

    expect(result.folders.map(folder=>folder.prefix)).toEqual([indexed]);
    expect(result.reconciliationNeeded).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls.map(call=>(call[0] as R2ListOptions).prefix)).toEqual(["Jobs/Clients/"]);
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

  it("hydrates a ready video thumbnail and Stream state without reading either object body",async()=>{
    const key="Jobs/Clients/Acme/flight.mov";
    const object={...r2Object(key),size:8192,httpMetadata:{contentType:"video/quicktime"}} as R2Object;
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'video')")
        .bind(key,"etag-a",8192,"2026-08-07T12:00:00.000Z","video/quicktime"),
      deliveryDb.prepare(`INSERT INTO image_thumbnail_jobs(source_key,source_etag,thumbnail_key,thumbnail_etag,thumbnail_size,status)
        VALUES(?,?,?,?,?,'ready')`).bind(key,"etag-a","_ltds/thumbnails/video.webp","thumb-video",123),
    ]);
    list.mockResolvedValue({objects:[object],delimitedPrefixes:[],truncated:false});

    const result=await listDeliveryFolderMedia(environment(),principal,"Jobs/Clients/Acme/");

    expect(result.items).toEqual([expect.objectContaining({
      thumbnailState:"ready",thumbnailUrl:expect.stringMatching(/\/thumbnail$/),previewStatus:"processing",
    })]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("hydrates a full 150-file page with bounded listing-scoped queries instead of per-item D1 reads",async()=>{
    const objects=Array.from({length:DELIVERY_FOLDER_PAGE_SIZE},(_,index)=>{
      const video=index%3===0,key=`Jobs/Clients/Acme/asset-${String(index).padStart(3,"0")}.${video?"mp4":"jpg"}`;
      return{...r2Object(key),httpMetadata:{contentType:video?"video/mp4":"image/jpeg"}} as R2Object;
    });
    for(let offset=0;offset<objects.length;offset+=50){
      const batch=objects.slice(offset,offset+50);
      await deliveryDb.batch(batch.flatMap((object,index)=>{
        const absolute=offset+index,video=object.key.endsWith(".mp4");
        return[
          deliveryDb.prepare(`INSERT INTO image_thumbnail_jobs(source_key,source_etag,thumbnail_key,thumbnail_etag,thumbnail_size,status)
            VALUES(?,?,?,?,?,'ready')`).bind(object.key,"etag-a",`_ltds/thumbnails/${absolute}.webp`,`thumb-${absolute}`,64),
          deliveryDb.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind,stream_uid,stream_status)
            VALUES(?,?,?,?,?,?,?,?)`).bind(object.key,"etag-a",1024,"2026-08-07T12:00:00.000Z",video?"video/mp4":"image/jpeg",video?"video":"image",video?`stream-${absolute}`:null,video?"ready":null),
        ];
      }));
    }
    list.mockResolvedValue({objects,delimitedPrefixes:[],truncated:true,cursor:"page-two"});

    const result=await listDeliveryFolder(environment(),principal,"Jobs/Clients/Acme/");

    expect(result.files).toHaveLength(DELIVERY_FOLDER_PAGE_SIZE);
    expect(result.files.every(file=>file.thumbnailState==="ready")).toBe(true);
    expect(result.files.filter(file=>file.kind==="video").every(file=>file.previewStatus==="ready")).toBe(true);
    expect(result.mediaHydrated).toBe(true);
    expect(result.nextCursor).toBe("page-two");
    expect(list).toHaveBeenCalledTimes(1);
    expect(deliveryQueries.filter(sql=>sql.includes("FROM image_thumbnail_jobs WHERE source_key IN"))).toHaveLength(2);
    expect(deliveryQueries.filter(sql=>sql.includes("FROM file_index WHERE r2_key IN"))).toHaveLength(2);
    expect(deliveryQueries.filter(sql=>sql.includes("WHERE source_key=?"))).toHaveLength(0);
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  },30_000);

  it("searches indexed Jobs content without exposing hidden namespaces or out-of-scope roots",async()=>{
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')").bind("Jobs/Clients/Tree-B-Gone/Edited/hero.jpg","etag-tree",123,"2026-08-07T12:00:00.000Z","image/jpeg"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')").bind("Jobs/Demo/Tree-B-Gone-demo.jpg","etag-demo",456,"2026-08-07T12:00:00.000Z","image/jpeg"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')").bind("_ltds/Tree-B-Gone/hidden.jpg","etag-hidden",999,"2026-08-07T12:00:00.000Z","image/jpeg"),
    ]);
    const result=await searchDeliveryItems(environment(),principal,"tree-b-gone");
    expect(result.items.map(item=>item.physicalKey)).toEqual(expect.arrayContaining(["Jobs/Clients/Tree-B-Gone/","Jobs/Clients/Tree-B-Gone/Edited/hero.jpg","Jobs/Demo/Tree-B-Gone-demo.jpg"]));
    expect(result.items.some(item=>item.physicalKey?.startsWith("_ltds/"))).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it("search keeps a division-scoped user inside their associated folder root",async()=>{
    await opsDb.batch([
      opsDb.prepare("DELETE FROM staff_role_assignments WHERE staff_id='staff-a'"),
      opsDb.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope,division_id) VALUES('staff-a','delivery-role','division','division-a')"),
      opsDb.prepare("INSERT INTO pa_projects(id,name) VALUES('project-a','Acme')"),
      opsDb.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix) VALUES('project-a','division-a','Jobs/Clients/Acme/')"),
      opsDb.prepare("INSERT INTO pa_projects(id,name) VALUES('project-b','Elsewhere')"),
      opsDb.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix) VALUES('project-b','division-b','Jobs/Clients/Elsewhere/')"),
    ]);
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')").bind("Jobs/Clients/Acme/Needle.jpg","etag-acme",1,"2026-08-07T12:00:00.000Z","image/jpeg"),
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')").bind("Jobs/Clients/Elsewhere/Needle.jpg","etag-other",1,"2026-08-07T12:00:00.000Z","image/jpeg"),
    ]);
    const result=await searchDeliveryItems(environment(),principal,"needle");
    expect(result.items.map(item=>item.physicalKey)).toContain("Jobs/Clients/Acme/Needle.jpg");
    expect(result.items.map(item=>item.physicalKey)).not.toContain("Jobs/Clients/Elsewhere/Needle.jpg");
  });
});
