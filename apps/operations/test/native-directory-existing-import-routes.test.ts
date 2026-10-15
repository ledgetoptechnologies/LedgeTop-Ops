import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { noRemoteCreateRows } from "./helpers/native-existing-import-fixture";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { fullImportDatabase, importCase } from "./helpers/native-existing-import-fixture";

// The trusted JWT boundary is isolated; all native actor/grant/source checks,
// candidate SQL and production migration triggers run against real D1.
const nativeAuth = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: nativeAuth.authenticate }));
import { registerNativeDirectoryExistingImportRoutes } from "../src/worker/native-directory-existing-import-routes";

let fixture: Awaited<ReturnType<typeof fullImportDatabase>>;
beforeAll(async () => { fixture = await fullImportDatabase(); }, 240_000);
afterAll(async () => { await fixture.runtime.dispose(); });

describe("existing import candidate route with current real native D1 authority", () => {
  it.each(["organization", "client"] as const)("filters classic and native %s resource denies before pagination", async kind => {
    const first = await importCase(fixture.db, kind, { classicId: `a-denied-${kind}` });
    const second = await importCase(fixture.db, kind, { classicId: `b-denied-${kind}`, sourceId: first.selection.sourceId, sourceFixture: first });
    const visible = await importCase(fixture.db, kind, { classicId: `c-visible-${kind}`, sourceId: first.selection.sourceId, sourceFixture: first });
    const table = kind === "organization" ? "pa_organizations" : "pa_clients";
    await fixture.db.batch([
      fixture.db.prepare(`UPDATE ${table} SET name='Denied classic customer name' WHERE id=?`).bind(first.selection.recordId),
      fixture.db.prepare(`UPDATE ${table} SET name='Denied native customer name' WHERE id=?`).bind(second.selection.recordId),
    ]);
    // Resource grants legally reference pre-existing native records. Build
    // those collision fixtures through the ordinary guarded native writer;
    // candidate GET must add no intents or materializations of its own.
    for (const recordId of [first.selection.recordId, second.nativeRecordId!]) {
      const mutationId=crypto.randomUUID(), createAdmissionId=`normal-route-fixture-${mutationId}`;
      const input: NativeDirectoryCreateWrite={operation:"create",mutationId,recordId,expectedLocalVersion:0,kind:"organization",createAdmissionId,
        profile:{name:"Existing native resource",generalEmail:"",generalPhone:"",addressLine1:"",addressLine2:"",city:"",state:"",postalCode:"",country:""},
        scopes:[{businessAreaId:first.selection.businessAreaId,divisionId:null}],
        destinations:[{sourceId:first.selection.sourceId,sourceInstanceUUID:first.identity.sourceInstanceId,applicationUUID:first.identity.applicationId,
          historyEpoch:first.identity.historyEpoch,origin:first.origin,externalCanonicalId:recordId,expectedAuthorizationGeneration:"5"}],
        actor:{staffId:first.actor.staffId,accessSubject:first.actor.accessSubject,admissionVersion:first.actor.admissionVersion,
          loginEmail:first.actor.loginEmail,profileVersion:first.actor.profileVersion,
          selectedGrantId:`${first.actor.staffId}:directory.profile.edit`,selectedIdentityGrantId:`${first.actor.staffId}:directory.identity.link`}};
      await fixture.db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId,first.actor.staffId,first.actor.accessSubject,recordId,"organization",JSON.stringify(input.scopes),
          JSON.stringify(input.profile),JSON.stringify(input.destinations.map(({expectedAuthorizationGeneration:_,...destination})=>destination)),first.actor.staffId).run();
      expect(await writeNativeDirectoryProfile(fixture.db,input)).toMatchObject({status:"written",recordId});
    }
    const outboxBefore=await noRemoteCreateRows(fixture.db);
    const permissions = kind === "organization" ? ["directory.profile.view", "directory.enrollment.manage"]
      : ["directory.profile.edit", "directory.identity.link"];
    await fixture.db.batch([first.selection.recordId, second.nativeRecordId!].map((recordId, index) => fixture.db.prepare(`
      INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by)
      VALUES(?,?,?,'deny','resource',?,?)`).bind(`route-deny-${kind}-${index}`, first.actor.staffId, permissions[index], recordId, first.actor.staffId)));
    const principal: StaffPrincipal = { id: first.actor.staffId, email: first.actor.loginEmail,
      displayName: "Native reviewer", accessSubject: first.actor.accessSubject, projectAlphaUserId: null };
    nativeAuth.authenticate.mockResolvedValue({ admissionVersion: first.actor.admissionVersion, verifiedUntil: first.actor.verifiedUntil,
      identity: { staffId: first.actor.staffId, email: first.actor.loginEmail, verifiedAccessSubject: first.actor.accessSubject,
        profileVersion: first.actor.profileVersion } });
    const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
    app.use("*", async (context, next) => { context.set("principal", principal); context.set("administrator", true); await next(); });
    registerNativeDirectoryExistingImportRoutes(app);
    const response = await app.request(`https://ops.example.test/api/client-hub/directory/existing-import/candidates?limit=1&sourceId=${encodeURIComponent(first.selection.sourceId)}`,
      undefined, first.env as Env);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { items: { recordId: string; sourceId: string }[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ recordId: visible.selection.recordId, sourceId: first.selection.sourceId });
    expect(body.nextCursor).toBeNull();
    expect(await noRemoteCreateRows(fixture.db)).toEqual(outboxBefore);
    expect(JSON.stringify(body)).not.toContain("Denied classic customer name");
    expect(JSON.stringify(body)).not.toContain("Denied native customer name");
    expect(JSON.stringify(body)).not.toContain(first.selection.recordId);
    expect(JSON.stringify(body)).not.toContain(second.selection.recordId);
  }, 60_000);
});
