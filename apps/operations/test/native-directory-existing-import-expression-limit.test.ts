import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Workerd's local SQLite may permit deeper expressions than production D1.
 * Compile the complete real guarded-write path with the provider's depth100. */
describe("existing import under production SQL expression depth", () => {
  it("compiles live review and native write guards with SQLITE_LIMIT_EXPR_DEPTH=100", () => {
    const script = String.raw`
import json,pathlib,sqlite3,sys
database=sqlite3.connect(':memory:')
for migration in sorted(pathlib.Path(sys.argv[1]).glob('[0-9][0-9][0-9][0-9]_*.sql')):
 database.executescript(migration.read_text(encoding='utf-8-sig'))
database.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
assert database.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH)==100
queries={
 'live_review':"SELECT import_id FROM native_directory_existing_import_live_reviews WHERE import_id='00000000-0000-4000-8000-000000000001'",
 'review_insert':"EXPLAIN INSERT INTO native_directory_existing_import_reviews(import_id,idempotency_key,request_sha256,review_json,created_at,expires_at) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','"+'a'*64+"','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z')",
 'execution_insert':"EXPLAIN INSERT INTO native_directory_existing_import_execution_admissions(execution_id,import_id,actor_json,created_at,verified_until) VALUES('execution','review','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z')",
 'create_admission':"EXPLAIN INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES('existing-import:00000000-0000-4000-8000-000000000001','staff','subject','native','organization','[]','{}','[]','staff')",
 'write_fence':"EXPLAIN INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes) VALUES('mutation','create','staff','subject',1,'directory.profile.edit','native','organization',0,'existing-import:mutation','grant','[]','{}','{}','[]',0)",
 'native_record':"EXPLAIN INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES('native','organization',1)",
 'native_revision':"EXPLAIN INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES('native',1,'mutation','{}')",
 'native_audit':"EXPLAIN INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject) VALUES('audit','mutation','native',1,'staff','staff','{}','subject')",
 'relationship_fence':"EXPLAIN INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,verified_until) VALUES('relationship','native',0,NULL,NULL,1,NULL,NULL,'staff','subject','staff@example.test',1,1,'2026-01-01T00:01:00.000Z')",
 'relationship':"EXPLAIN INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version) VALUES('native',NULL,1)",
 'local_receipt':"EXPLAIN INSERT INTO native_directory_existing_import_local_receipts(import_id,record_id,execution_id,mutation_id,created_at) VALUES('review','native','execution','mutation','2026-01-01T00:00:00.000Z')",
 'translation':"EXPLAIN INSERT INTO native_directory_existing_import_identity_translations(import_id,source_id,record_kind,classic_record_id,native_record_id,public_id,created_at) VALUES('review','project-alpha:primary','organization','1','native','"+'a'*32+"','2026-01-01T00:00:00.000Z')",
}
# Compile complete trigger paths for transport, renewal, cursor and activation too.
for table in ['native_directory_existing_import_binding_intents','native_directory_existing_import_source_cursors',
 'native_directory_existing_import_renewals','native_directory_existing_import_events',
 'project_alpha_existing_directory_binding_review_evidence',
 'project_alpha_existing_directory_binding_acquired_mapping_receipts',
 'project_alpha_acquired_canonical_mappings','project_alpha_acquired_native_owner_claims',
 'project_alpha_existing_directory_binding_activation_receipts']:
 columns=[row[1] for row in database.execute('PRAGMA table_xinfo('+table+')') if row[6]==0]
 queries[table+'_insert']='EXPLAIN INSERT INTO '+table+'('+','.join(columns)+') VALUES('+','.join("'fixture'" for _ in columns)+')'
queries['cursor_update']="EXPLAIN UPDATE native_directory_existing_import_source_cursors SET generation='6',last_import_id='review' WHERE batch_id='batch' AND source_id='project-alpha:primary'"
queries['active_mappings_select']="SELECT * FROM project_alpha_active_directory_mappings WHERE record_id='fixture'"
failures=[]
for label,query in queries.items():
 try:database.execute(query).fetchall()
 except sqlite3.Error as error:failures.append({'path':label,'error':str(error)})
print(json.dumps({'limit':100,'compiled':len(queries)-len(failures),'paths':len(queries),'failures':failures}))
sys.exit(1 if failures else 0)
`;
    const result = spawnSync(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      ["-c", script, fileURLToPath(new URL("../migrations/", import.meta.url))], { encoding: "utf8", timeout: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const proof = JSON.parse(result.stdout) as { limit: number; paths: number; compiled: number; failures: unknown[] };
    expect(proof.limit).toBe(100); expect(proof.failures).toEqual([]); expect(proof.compiled).toBe(proof.paths);
  });
});
