import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {Miniflare} from "miniflare";

const mocks=vi.hoisted(()=>({staff:vi.fn(),native:vi.fn(),review:vi.fn(),authorize:vi.fn()}));
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));
vi.mock("../src/worker/auth",()=>({authenticateStaff:mocks.staff}));
vi.mock("../src/worker/native-staff-auth",()=>({authenticateNativeStaffWithAdmissionVersion:mocks.native}));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery-service",()=>({
  createDirectoryRelationshipRecoveryReview:mocks.review,
  authorizeDirectoryRelationshipRecoveryReview:mocks.authorize,
}));
import worker from "../src/worker/index";
import {csrfToken} from "../src/worker/request-security";
import type {Env,StaffPrincipal} from "../src/worker/types";

const origin="https://ops.example",record="client-record",reviewId="10000000-0000-4000-8000-000000000001";
const authorizationId="10000000-0000-4000-8000-000000000002",successor="10000000-0000-4000-8000-000000000003";
const principal:StaffPrincipal={id:"admin",email:"admin@example.test",displayName:"Admin",accessSubject:"access|admin",projectAlphaUserId:null};
const execution={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
let runtime:Miniflare,db:D1Database,base:Env;
const path=`/api/client-hub/directory/standalone-clients/${record}/relationship-generation-recovery`;
function environment(enabled=true){return{...base,NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED:"true",
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED:enabled?"true":"false"} as Env;}
async function post(suffix:string,body:unknown,env=environment(),headers:Record<string,string>={}){
  return worker.fetch(new Request(`${origin}${path}${suffix}`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)}),env,execution);}

describe("relationship generation recovery index mutation middleware",()=>{
  beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    await db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,status TEXT);CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,
      staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);CREATE TABLE local_staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,
      role_id TEXT,scope TEXT,division_id TEXT);CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT,PRIMARY KEY(role_id,permission_key));
      CREATE TABLE staff_permission_overrides(id TEXT PRIMARY KEY,staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);`.replace(/\s*\n\s*/gu," "));
    await db.batch([db.prepare("INSERT INTO staff_users VALUES(?,?,'active')").bind(principal.id,principal.email),
      db.prepare("INSERT INTO staff_role_assignments VALUES('admin-role',?,'role-owner','global',NULL)").bind(principal.id)]);
    base={OPS_DB:db,ENVIRONMENT:"development",EXPECTED_HOST:"ops.example",PUBLIC_BASE_URL:origin,INCOMING_EXPECTED_HOST:"incoming.example",
      INCOMING_BASE_URL:"https://incoming.example",OPERATIONS_SESSION_SECRET:"relationship-recovery-index-secret-at-least-32-bytes",
      TEAM_DOMAIN:"https://team.example",OPERATIONS_AUD:"operations"} as unknown as Env;
  });
  beforeEach(()=>{vi.clearAllMocks();mocks.staff.mockResolvedValue(principal);mocks.native.mockResolvedValue({identity:{kind:"native",staffId:principal.id,
    email:principal.email,verifiedAccessSubject:principal.accessSubject,displayName:principal.displayName,profileVersion:1},admissionVersion:1,
    verifiedUntil:new Date(Date.now()+300_000).toISOString()});mocks.review.mockResolvedValue({status:"review",review:{reviewId,recordId:record,
      sourceId:"project-alpha:test",predecessorCommandId:"p",evidenceSha256:"a".repeat(64),clientRevision:"7",organizationRevision:"9",
      organizationRecordId:"org",remoteParentPublicId:null,observedAuthorizationGeneration:"11",expiresAt:"2999-01-01T00:00:00.000Z"}});
    mocks.authorize.mockResolvedValue({status:"prepared",successorCommandId:successor,generation:"11",replayed:false});});
  afterAll(async()=>runtime.dispose());

  it("is absent while default-off before staff authentication or database authority reads",async()=>{
    const response=await post("/reviews",{sourceId:"project-alpha:test"},environment(false));
    expect(response.status).toBe(404);expect(mocks.staff).not.toHaveBeenCalled();expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();expect(mocks.authorize).not.toHaveBeenCalled();});

  it.each<Record<string,string>>([{Origin:"https://evil.example"},{Origin:origin},{Origin:origin,"X-CSRF-Token":"invalid"}])(
    "rejects cross-origin or missing/invalid CSRF before either service write: %j",async headers=>{
      const response=await post("/reviews",{sourceId:"project-alpha:test"},environment(),headers);
      expect(response.status).toBe(403);expect(mocks.review).not.toHaveBeenCalled();expect(mocks.authorize).not.toHaveBeenCalled();});

  it("allows same-origin valid-CSRF requests to reach each correct handler under trusted auth",async()=>{
    const token=await csrfToken(environment(),principal),headers={Origin:origin,"X-CSRF-Token":token,"Sec-Fetch-Site":"same-origin"};
    const reviewed=await post("/reviews",{sourceId:"project-alpha:test"},environment(),headers);
    expect(reviewed.status).toBe(200);expect(mocks.review).toHaveBeenCalledOnce();expect(mocks.review).toHaveBeenCalledWith(expect.anything(),
      {recordId:record,sourceId:"project-alpha:test"},expect.objectContaining({staffId:principal.id,accessSubject:principal.accessSubject}),expect.any(Function));
    expect(mocks.authorize).not.toHaveBeenCalled();
    const authorized=await post(`/reviews/${reviewId}/authorize`,{evidenceSha256:"a".repeat(64),authorizationId,successorCommandId:successor,
      reason:"Reviewed exact generation conflict"},environment(),{...headers,"Idempotency-Key":authorizationId});
    expect(authorized.status).toBe(200);expect(mocks.authorize).toHaveBeenCalledOnce();expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({recordId:record,reviewId,authorizationId,successorCommandId:successor}),
      expect.objectContaining({staffId:principal.id,accessSubject:principal.accessSubject}));});
});
