import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe,expect,it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
// Existing reviewed test artifact generator; no declarations are provided.
// @ts-expect-error test-only JavaScript artifact module
import { transformSeed } from "../../../scripts/staging-bootstrap.mjs";

const migration=readFileSync(new URL("../migrations/0191_operations_portal_native_billing_authority.sql",import.meta.url),"utf8");

describe("native billing authority migration",()=>{
  it("is default-off and does not widen native v3",()=>{
    expect(migration).toContain("INSERT INTO permissions(key,description) VALUES\n ('billing.portal_access.manage'");
    expect(migration).not.toMatch(/INSERT(?: OR IGNORE)? INTO role_permissions/iu);
    expect(migration).not.toMatch(/operations_portal_native_recipient_authority_heads[\s\S]*permissions_json\s*=/iu);
    expect(migration).not.toContain("operations.service_home.read");
    expect(migration).not.toContain("publication_source_sequence=publication_revision");
  });

  it("binds exact current actor, recipient, publication and entity ownership",()=>{
    for(const proof of ["native_staff_admissions","native_staff_profiles","operations_portal_native_billing_permission_generations",
      "billing.portal_access.manage","effect='deny'","operations_portal_native_recipient_authority_heads",
      "client_onboarding_recipient_identity_bindings","operations_portal_workspace_publication_heads",
      "operations_portal_workspace_publication_receipts","operations_portal_workspace_publication_project_sources",
      "recipient_receipt.request_fingerprint=NEW.recipient_request_fingerprint",
      "publication_receipt.operation_fingerprint=NEW.publication_request_fingerprint",
      "operations_portal_workspace_effective_billing_permissions",
      "source.project_version=project.current_version","source.archived=project.archived",
      "project.organization_record_id IS NULL","project.client_record_id=NEW.target_client_record_id"])
      expect(migration).toContain(proof);
  });

  it("requires acknowledged exact bytes before a grant head can change",()=>{
    expect(migration).toContain("outbox.request_sha256=NEW.request_sha256");
    expect(migration).toContain("outbox.state='acknowledged'");
    expect(migration).toContain("outbox.acknowledged_claim_token=NEW.acknowledged_claim_token");
    expect(migration).toContain("command.expected_revision=OLD.revision");
    expect(migration).toContain("command.resulting_revision=NEW.revision");
    expect(migration).toContain("UNIQUE(recipient_binding_id,entity_kind,native_entity_id)");
    expect(migration).toContain("native billing command bytes are not exact");
  });

  it("keeps command, receipt and identity history durable",()=>{
    expect((migration.match(/is immutable/gu)??[]).length).toBeGreaterThanOrEqual(3);
    expect((migration.match(/is durable/gu)??[]).length).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("CREATE VIEW operations_portal_native_billing_live_authority");
    expect(migration).toContain("head.expires_at IS NULL OR head.expires_at>");
  });

  it("applies after the current reviewed schema without changing existing rows",async()=>{
    const runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",
      d1Databases:{OPS_DB:crypto.randomUUID()}});
    try{
      const directory=new URL("../migrations/",import.meta.url),database=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
      const reviewed=reviewedOperationsMigrationNames(directory);
      expect(reviewed.at(-1)).toBe("0196_native_directory_maintenance_authority.sql");
      const suffix=["0191_operations_portal_native_billing_authority.sql","0192_ops_service_definition_authority.sql"];
      expect(suffix.every(name=>reviewed.includes(name))).toBe(true);
      const historical=reviewed.slice(0,reviewed.indexOf("0193_operations_portal_native_delivery_dead_conflict_recovery.sql"));
      const names=historical.filter(name=>!suffix.includes(name));
      expect(names.at(-1)).toBe("0190_client_hub_native_project_preparation_authority.sql");
      await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
      const owner={email:"billing-schema-owner@staging.example.test",displayName:"Synthetic Staging Billing Schema Owner",
        clientStaffId:"staging-billing-schema-client-owner",operationsStaffId:"staging-billing-schema-operations-owner"};
      for(const name of names){const raw=readFileSync(new URL(name,directory),"utf8");
        const source=name==="0002_seed_acl.sql"?transformSeed("operations",raw.replace(/\r\n/gu,"\n"),owner) as string:raw;
        await database.batch([...splitD1MigrationStatements(source).map(statement=>database.prepare(statement)),
          database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);}
      const before=await database.prepare("SELECT count(*) count FROM operations_portal_native_recipient_authority_heads").first<{count:number}>();
      const statements=splitD1MigrationStatements(migration);
      for(const [index,statement] of statements.entries()){
        try{await database.prepare(statement).run();}
        catch(error){throw new Error(`0191 statement ${index+1} failed: ${statement.slice(0,120)}`,{cause:error});}
      }
      expect((await database.prepare("SELECT count(*) count FROM operations_portal_native_recipient_authority_heads").first<{count:number}>())?.count)
        .toBe(before?.count);
      expect(await database.prepare("SELECT key FROM permissions WHERE key='billing.portal_access.manage'").first()).not.toBeNull();
      expect((await database.prepare("SELECT count(*) count FROM role_permissions WHERE permission_key='billing.portal_access.manage'")
        .first<{count:number}>())?.count).toBe(0);
      expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    }finally{await runtime.dispose();}
  },300_000);

  it("joins exact command bytes through acknowledged grant, CAS revoke, and deny-aware rejection",async()=>{
    const runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",
      d1Databases:{OPS_DB:crypto.randomUUID()}});
    try{
      const db=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
      await db.batch(splitD1MigrationStatements(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT NOT NULL);
        CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT);
        CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT,
          resource_id TEXT,business_area_id TEXT,division_id TEXT);
        CREATE TABLE native_directory_assignments(staff_id TEXT,record_id TEXT,active INTEGER);
        CREATE TABLE native_directory_resource_scopes(record_id TEXT,business_area_id TEXT,division_id TEXT,active INTEGER);
        CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER);
        CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER);
        CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER);
        CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
        CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER);
        CREATE TABLE staff_users(id TEXT PRIMARY KEY,status TEXT,access_subject TEXT);
        CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
        CREATE TABLE operations_portal_native_workspace_authority_heads(target_id TEXT PRIMARY KEY,target_revision INTEGER,
          client_authority_id TEXT,workspace_id TEXT,root_kind TEXT,root_record_id TEXT,ownership_epoch INTEGER,state TEXT);
        CREATE TABLE operations_portal_native_recipient_authority_heads(recipient_binding_id TEXT PRIMARY KEY,
          target_id TEXT,enrollment_intent_id TEXT,target_client_record_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,
          grant_revision INTEGER,latest_operation_id TEXT,state TEXT);
        CREATE TABLE operations_portal_native_authority_receipts(operation_id TEXT PRIMARY KEY,request_fingerprint TEXT);
        CREATE TABLE client_onboarding_recipient_identity_bindings(binding_id TEXT PRIMARY KEY,target_client_record_id TEXT,
          access_issuer TEXT,access_subject TEXT,status TEXT,expires_at TEXT);
        CREATE TABLE operations_portal_workspace_publication_receipts(operation_id TEXT PRIMARY KEY,publication_id TEXT,
          operation_fingerprint TEXT,resulting_revision INTEGER,source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT);
        CREATE TABLE operations_portal_workspace_publication_heads(target_id TEXT PRIMARY KEY,publication_revision INTEGER,
          source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT,latest_operation_id TEXT);
        CREATE TABLE operations_portal_workspace_publication_project_sources(checkpoint_id TEXT,external_project_id TEXT,
          project_version INTEGER,archived INTEGER,organization_record_id TEXT,client_record_id TEXT);
        CREATE TABLE operations_portal_workspace_publication_snapshots(snapshot_id TEXT PRIMARY KEY,checkpoint_id TEXT);
        CREATE TABLE operations_shared_projects(external_project_id TEXT PRIMARY KEY,current_version INTEGER,archived INTEGER,
          organization_record_id TEXT,client_record_id TEXT);
      `).map(statement=>db.prepare(statement)));
      await db.batch(splitD1MigrationStatements(migration).map(statement=>db.prepare(statement)));
      const id=(n:number)=>`${String(n).padStart(8,"0")}-0000-4000-8000-000000000000`;
      const target=id(1),clientAuthority=id(2),binding=id(3),intent=id(4),homeOperation=id(5),publicationOperation=id(6),
        publication=id(7),snapshot=id(8),grant=id(9),grantOperation=id(10),revokeOperation=id(11);
      const root="organization:billing",client="client:billing",staff="staff:billing",issuer="https://team.cloudflareaccess.com",
        subject="access|billing",fingerprint="a".repeat(64),publicationFingerprint="b".repeat(64),snapshotHash="c".repeat(64),
        observed=new Date().toISOString(),verified="2099-10-11T00:00:00.000Z";
      await db.batch([
        db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization'),(?,'client')").bind(root,client),
        db.prepare("INSERT INTO native_staff_admissions VALUES(?,1,'access|staff',2)").bind(staff),
        db.prepare("INSERT INTO native_staff_profiles VALUES(?,3)").bind(staff),
        db.prepare("INSERT INTO native_directory_grant_generations VALUES(?,4)").bind(staff),
        db.prepare("INSERT INTO staff_users VALUES(?,'active','access|staff')").bind(staff),
        db.prepare("INSERT INTO native_directory_grants VALUES(?,'directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)").bind(staff),
        db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(staff),
        db.prepare("INSERT INTO operations_portal_native_workspace_authority_heads VALUES(?,1,?,?,'organization',?,1,'active')")
          .bind(target,clientAuthority,"workspace-billing",root),
        db.prepare("INSERT INTO operations_portal_native_recipient_authority_heads VALUES(?,?,?,?,?,?,1,1,?,'active')")
          .bind(binding,target,intent,client,issuer,subject,homeOperation),
        db.prepare("INSERT INTO operations_portal_native_authority_receipts VALUES(?,?)").bind(homeOperation,fingerprint),
        db.prepare("INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?,?,?,?, 'active',NULL)").bind(binding,client,issuer,subject),
        db.prepare("INSERT INTO operations_portal_workspace_publication_receipts VALUES(?,?,?,5,6,?,?)")
          .bind(publicationOperation,publication,publicationFingerprint,snapshot,snapshotHash),
        db.prepare("INSERT INTO operations_portal_workspace_publication_heads VALUES(?,5,6,?,?,?)")
          .bind(target,snapshot,snapshotHash,publicationOperation),
      ]);
      const permissionOperation=id(40),permissionGrant=id(41);
      await db.prepare("INSERT INTO operations_portal_native_billing_permission_generations VALUES(?,3,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
        .bind(staff).run();
      await db.prepare(`INSERT INTO operations_portal_native_billing_permission_commands
        (operation_id,request_fingerprint,action,grant_id,staff_id,effect,scope_kind,resource_id,expected_generation,
         resulting_generation,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
         actor_verified_until,observed_at) VALUES(?,?,'issue',?,?,'allow','resource',?,3,4,?,'access|staff',2,3,?,?)`)
        .bind(permissionOperation,"9".repeat(64),permissionGrant,staff,root,staff,verified,observed).run();
      await db.prepare(`INSERT INTO operations_portal_native_billing_permissions
        (grant_id,issue_operation_id,staff_id,effect,scope_kind,resource_id,issued_generation)
        VALUES(?, ?,?,'allow','resource',?,4)`).bind(permissionGrant,permissionOperation,staff,root).run();
      await db.prepare(`UPDATE operations_portal_native_billing_permission_generations
        SET generation=4,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=?`).bind(staff).run();
      const command=(operationId:string,action:"billing.grant"|"billing.revoke",expected:number,resulting:number,
        observedAt=observed,entityKind:"organization"|"client"|"project"="organization",nativeEntityId=root,actorGeneration=4)=>({
        protocol:"operations-portal-native-billing-authority",protocolVersion:1,action,operationId,
        authority:{grantId:grant,expectedRevision:String(expected),resultingRevision:String(resulting)},
        workspace:{targetId:target,targetRevision:"1",clientAuthorityId:clientAuthority,workspaceId:"workspace-billing",
          rootKind:"organization",rootRecordId:root},
        recipient:{recipientBindingId:binding,enrollmentIntentId:intent,targetClientRecordId:client,issuer,subject,
          ownershipEpoch:"1",grantRevision:"1",grantOperationId:homeOperation,requestFingerprint:fingerprint},
        publication:{operationId:publicationOperation,publicationId:publication,revision:"5",sourceSequence:"6",snapshotId:snapshot,
          snapshotSha256:snapshotHash,requestFingerprint:publicationFingerprint},
        entity:{kind:entityKind,nativeId:nativeEntityId},actorProof:{staffId:staff,verifiedAccessSubject:"access|staff",
          admissionVersion:"2",profileVersion:"3",grantGeneration:String(actorGeneration),verifiedUntil:verified},
        expiresAt:null,observedAt});
      const insertCommand=async(operationId:string,action:"billing.grant"|"billing.revoke",expected:number,resulting:number,
        observedAt=observed,entityKind:"organization"|"client"|"project"="organization",nativeEntityId=root,actorGeneration=4)=>{
        const wire=JSON.stringify(command(operationId,action,expected,resulting,observedAt,entityKind,nativeEntityId,actorGeneration)),sha=action==="billing.grant"?"d".repeat(64):"e".repeat(64);
        await db.prepare(`INSERT INTO operations_portal_native_billing_authority_commands
          (operation_id,request_sha256,canonical_command_json,action,grant_id,expected_revision,resulting_revision,
           target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,
           enrollment_intent_id,target_client_record_id,issuer,subject,ownership_epoch,recipient_grant_revision,
           recipient_grant_operation_id,recipient_request_fingerprint,publication_operation_id,publication_id,
           publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
           publication_request_fingerprint,entity_kind,native_entity_id,actor_staff_id,actor_access_subject,
           actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,expires_at,observed_at)
          VALUES(?,?,?,?,?,?,?, ?,1,?,'workspace-billing','organization',?,?,?,?,?,?,1,1,?,?, ?,?,5,6,?,?,?,
            ?,?,?, 'access|staff',2,3,?, ?,NULL,?)`)
          .bind(operationId,sha,wire,action,grant,expected,resulting,target,clientAuthority,root,binding,intent,client,issuer,subject,
            homeOperation,fingerprint,publicationOperation,publication,snapshot,snapshotHash,publicationFingerprint,
            entityKind,nativeEntityId,staff,actorGeneration,verified,observedAt).run();
        return{wire,sha};
      };
      await expect(insertCommand(id(16),"billing.grant",0,1,observed,"project","project:mismatched"))
        .rejects.toThrow(/entity is not current and exact/u);
      const granted=await insertCommand(grantOperation,"billing.grant",0,1);
      await expect(db.prepare(`INSERT INTO operations_portal_native_billing_authority_outbox
        (operation_id,request_sha256,canonical_wire_json,state,attempts,acknowledged_claim_token)
        VALUES(?,?,?,'acknowledged',1,'forged-ack')`).bind(grantOperation,granted.sha,granted.wire).run())
        .rejects.toThrow(/outbox is not exact/u);
      await db.prepare("INSERT INTO operations_portal_native_billing_authority_outbox(operation_id,request_sha256,canonical_wire_json) VALUES(?,?,?)")
        .bind(grantOperation,granted.sha,granted.wire).run();
      await expect(db.prepare(`UPDATE operations_portal_native_billing_authority_outbox
        SET state='acknowledged',acknowledged_claim_token='unclaimed' WHERE operation_id=?`).bind(grantOperation).run())
        .rejects.toThrow(/transition is invalid/u);
      await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='claimed',attempts=1,
        lease_token='claim-grant',lease_expires_at=unixepoch()*1000+60000 WHERE operation_id=?`).bind(grantOperation).run();
      await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='acknowledged',lease_token=NULL,
        lease_expires_at=NULL,acknowledged_claim_token='claim-grant' WHERE operation_id=?`).bind(grantOperation).run();
      await db.prepare("INSERT INTO operations_portal_native_billing_authority_receipts VALUES(?,?,?,1,'active','claim-grant',?)")
        .bind(grantOperation,granted.sha,grant,observed).run();
      const finalization=id(15),finalizationVerified=new Date(Date.now()+3_000).toISOString(),insertFinalization=()=>db.prepare(`INSERT INTO operations_portal_native_billing_grant_finalizations
        (finalization_id,operation_id,request_sha256,grant_id,current_target_revision,current_ownership_epoch,
         current_recipient_grant_revision,current_recipient_grant_operation_id,current_publication_operation_id,
         current_publication_revision,current_publication_source_sequence,current_publication_snapshot_id,
         current_publication_snapshot_sha256,actor_staff_id,actor_access_subject,actor_admission_version,
         actor_profile_version,actor_grant_generation,actor_verified_until,observed_at)
        VALUES(?,?,?,?,1,1,1,?,?,5,6,?,?,?,'access|staff',2,3,4,?,?)`)
        .bind(finalization,grantOperation,granted.sha,grant,homeOperation,publicationOperation,snapshot,snapshotHash,staff,finalizationVerified,observed).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_authority_receipts WHERE operation_id=?")
        .bind(grantOperation).first<{count:number}>())?.count).toBe(1);
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_authority_heads").first<{count:number}>())?.count).toBe(0);
      await db.prepare("UPDATE operations_portal_workspace_publication_heads SET publication_revision=7 WHERE target_id=?").bind(target).run();
      await expect(insertFinalization()).rejects.toThrow(/finalization lineage is not current/u);
      await db.prepare("UPDATE operations_portal_workspace_publication_heads SET publication_revision=5 WHERE target_id=?").bind(target).run();
      await insertFinalization();
      const insertHead=()=>db.prepare("INSERT INTO operations_portal_native_billing_authority_heads VALUES(?,?,'organization',?,1,'active',NULL,?,?,?,?)")
        .bind(grant,binding,root,finalization,grantOperation,grantOperation,observed).run();
      await insertHead();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(1);
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(finalizationVerified)-Date.now()+50)));
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_current_finalization_actor").first<{count:number}>())?.count).toBe(0);
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_effective_finalization_actor").first<{count:number}>())?.count).toBe(1);
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(1);
      await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(staff).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(0);
      await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(staff).run();
      await db.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at='2000-01-01T00:00:00.000Z' WHERE binding_id=?").bind(binding).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(0);
      await db.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at=NULL WHERE binding_id=?").bind(binding).run();

      await expect(insertCommand(id(13),"billing.grant",1,2,new Date(Date.now()+60_000).toISOString()))
        .rejects.toThrow(/currently authorized/u);
      await expect(insertCommand(id(14),"billing.grant",1,2,new Date(Date.now()-16*60_000).toISOString()))
        .rejects.toThrow(/currently authorized/u);

      await db.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='revoked' WHERE binding_id=?").bind(binding).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(0);
      await db.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='active' WHERE binding_id=?").bind(binding).run();

      await db.prepare(`UPDATE operations_portal_workspace_publication_heads SET publication_revision=2,source_sequence=3,
        snapshot_id=?,snapshot_sha256=?,latest_operation_id=? WHERE target_id=?`)
        .bind(id(20),"f".repeat(64),id(21),target).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(0);

      await expect(insertCommand(id(12),"billing.grant",0,1)).rejects.toThrow(/revision is stale/u);
      await db.prepare("UPDATE operations_portal_native_recipient_authority_heads SET state='revoked',grant_revision=2,enrollment_intent_id=? WHERE recipient_binding_id=?")
        .bind(id(30),binding).run();
      await db.prepare("UPDATE operations_portal_native_workspace_authority_heads SET target_revision=2,ownership_epoch=2,root_record_id=? WHERE target_id=?")
        .bind("organization:retargeted",target).run();
      const revoked=await insertCommand(revokeOperation,"billing.revoke",1,2);
      await db.prepare("INSERT INTO operations_portal_native_billing_authority_outbox(operation_id,request_sha256,canonical_wire_json) VALUES(?,?,?)")
        .bind(revokeOperation,revoked.sha,revoked.wire).run();
      await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='claimed',attempts=1,
        lease_token='claim-revoke',lease_expires_at=unixepoch()*1000+60000 WHERE operation_id=?`).bind(revokeOperation).run();
      await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='acknowledged',lease_token=NULL,
        lease_expires_at=NULL,acknowledged_claim_token='claim-revoke' WHERE operation_id=?`).bind(revokeOperation).run();
      await db.prepare("INSERT INTO operations_portal_native_billing_authority_receipts VALUES(?,?,?,2,'revoked','claim-revoke',?)")
        .bind(revokeOperation,revoked.sha,grant,observed).run();
      await db.prepare("UPDATE operations_portal_native_billing_authority_heads SET revision=2,state='revoked',latest_operation_id=?,updated_at=? WHERE grant_id=?")
        .bind(revokeOperation,observed,grant).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_live_authority").first<{count:number}>())?.count).toBe(0);
      const denyOperation=id(42),denyGrant=id(43);
      await db.prepare(`INSERT INTO operations_portal_native_billing_permission_commands
        (operation_id,request_fingerprint,action,grant_id,staff_id,effect,scope_kind,resource_id,expected_generation,
         resulting_generation,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
         actor_verified_until,observed_at) VALUES(?,?,'issue',?,?,'deny','resource',?,4,5,?,'access|staff',2,3,?,?)`)
        .bind(denyOperation,"8".repeat(64),denyGrant,staff,root,staff,verified,new Date().toISOString()).run();
      await db.prepare(`INSERT INTO operations_portal_native_billing_permissions
        (grant_id,issue_operation_id,staff_id,effect,scope_kind,resource_id,issued_generation)
        VALUES(?, ?,?,'deny','resource',?,5)`).bind(denyGrant,denyOperation,staff,root).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_effective_finalization_actor").first<{count:number}>())?.count).toBe(0);
      await db.prepare(`UPDATE operations_portal_native_billing_permission_generations
        SET generation=5,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=?`).bind(staff).run();
      expect((await db.prepare("SELECT count(*) count FROM operations_portal_native_billing_effective_finalization_actor").first<{count:number}>())?.count).toBe(0);
    }finally{await runtime.dispose();}
  },30_000);
});
