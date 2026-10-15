import { importDestination, importUuid, nativeExistingImportAuthority, nativeExistingImportEnabled, sameImportActor, nativeImportConfiguredReview } from "./native-directory-existing-import-common";
import { nativeExistingImportRecordId } from "./native-directory-existing-import-identity";
import type { NativeExistingImportActor, NativeExistingImportEnvironment, NativeExistingImportReview } from "./native-directory-existing-import-types";

export type NativeExistingImportWriteOutcome = Readonly<{ status: "imported"; recordId: string; replayed: boolean }>
  | Readonly<{ status: "blocked" | "conflict"; reason: string }>;

/** A real native create admission/write fence, with reviewed existing-object
 * provenance and zero PA create intents. Normal record/revision/audit/scope,
 * enrollment and relationship guards remain responsible for the atomic write. */
export async function writeNativeExistingDirectoryImport(env: NativeExistingImportEnvironment,
  review: NativeExistingImportReview, actor: NativeExistingImportActor): Promise<NativeExistingImportWriteOutcome> {
  if (!await nativeExistingImportEnabled(env) || !sameImportActor(review, actor) || !nativeImportConfiguredReview(env,review)) return { status: "blocked", reason: "authority" };
  if (review.nativeRecordId !== nativeExistingImportRecordId(review.sourceId, review.kind, review.recordId))
    return { status: "blocked", reason: "identity" };
  const db = env.OPS_DB.withSession("first-primary");
  const saved = await db.prepare("SELECT review_json FROM native_directory_existing_import_reviews WHERE import_id=?")
    .bind(review.importId).first<string>("review_json");
  if (saved !== JSON.stringify(review)) return { status: "blocked", reason: "review" };
  const grants = await nativeExistingImportAuthority(env, actor, review.sourceId, review.kind, review.recordId, review.businessAreaId);
  if (!grants || JSON.stringify(grants) !== JSON.stringify(review.selectedGrants)) return { status: "blocked", reason: "authority" };
  const prior = await db.prepare(`SELECT receipt.record_id,revision.profile_json FROM native_directory_existing_import_local_receipts receipt
    JOIN operations_directory_revisions revision ON revision.record_id=receipt.record_id AND revision.version=1
    WHERE receipt.import_id=?`).bind(review.importId).first<{ record_id: string; profile_json: string }>();
  if (prior) return prior.record_id === review.nativeRecordId && prior.profile_json === JSON.stringify(review.profile)
    ? { status: "imported", recordId: prior.record_id, replayed: true } : { status: "conflict", reason: "local_receipt" };
  let parentVersion: number | null = null;
  if (review.parentNativeRecordId !== null) {
    const parent = await db.prepare(`SELECT record.current_version FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='organization'
      JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
      WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
        AND mapping.resource_type='organization' AND mapping.record_id=? AND mapping.project_alpha_public_id=? LIMIT 2`)
      .bind(review.sourceId, review.sourceInstanceId, review.applicationId, review.historyEpoch,
        review.parentNativeRecordId, review.parentPublicId).all<{ current_version: number }>();
    if (parent.results.length !== 1) return { status: "blocked", reason: "parent_not_activated" };
    parentVersion = parent.results[0]!.current_version;
  }
  const executionId = crypto.randomUUID(), now = new Date().toISOString();
  const deadline = new Date(Math.min(Date.parse(actor.verifiedUntil), Date.now() + 15 * 60_000)).toISOString();
  const admissionId = `existing-import:${review.importId}`, profile = JSON.stringify(review.profile);
  const scopes = JSON.stringify([{ businessAreaId: review.businessAreaId, divisionId: null }]);
  const destinations = JSON.stringify([importDestination(review)]);
  const selected = grants.find(grant => grant.permission === "directory.profile.edit")!;
  const relationshipId = await importUuid(`existing-import-relationship:${review.importId}`);
  const audit = JSON.stringify({ operation: "import_existing", importId: review.importId, mutationId: review.importId,
    recordId: review.nativeRecordId, classicRecordId: review.recordId, resourceType: review.kind, profile: review.profile,
    sourceId: review.sourceId, publicId: review.publicId, scopes: JSON.parse(scopes), destinations: JSON.parse(destinations) });
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO native_directory_existing_import_execution_admissions(execution_id,import_id,actor_json,created_at,verified_until)
      VALUES(?,?,?,?,?)`).bind(executionId, review.importId, JSON.stringify(actor), now, deadline),
    db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, actor.staffId,
      actor.accessSubject, review.nativeRecordId, review.kind, scopes, profile, destinations, actor.staffId),
  ];
  if (review.kind === "client") statements.push(db.prepare(`INSERT INTO native_directory_create_admission_relationships
    (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,?)`)
    .bind(admissionId, review.nativeRecordId, review.parentNativeRecordId, parentVersion));
  statements.push(
    db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
      actor_admission_version,permission,record_id,record_kind,expected_version,create_admission_id,selected_grant_id,
      scopes_json,profile_json,command_json,destinations_json,intent_writes)
      VALUES(?,'create',?,?,?,'directory.profile.edit',?,?,0,?,?,?,?,?,?,0)`).bind(review.importId, actor.staffId,
      actor.accessSubject, actor.admissionVersion, review.nativeRecordId, review.kind, admissionId, selected.id, scopes, profile, audit, destinations),
    db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,?,1)").bind(review.nativeRecordId, review.kind),
    db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,?,?)").bind(review.nativeRecordId, review.importId, profile),
    db.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,
      command_json,original_verified_access_subject) VALUES(?,?,?,1,'staff',?,?,?)`).bind(`${review.importId}:audit`, review.importId,
      review.nativeRecordId, actor.staffId, audit, actor.accessSubject),
  );
  if (review.kind === "client") statements.push(
    db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,expected_relationship_version,
      previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,
      organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,verified_until)
      VALUES(?,?,0,NULL,?,1,NULL,?,?,?,?,?,?,?)`).bind(relationshipId, review.nativeRecordId, review.parentNativeRecordId,
      parentVersion, actor.staffId, actor.accessSubject, actor.loginEmail, actor.admissionVersion, actor.profileVersion, deadline),
    db.prepare(`INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version)
      VALUES(?,?,1)`).bind(review.nativeRecordId, review.parentNativeRecordId),
    db.prepare("DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?").bind(relationshipId),
  );
  statements.push(
    db.prepare("DELETE FROM operations_directory_write_fences WHERE mutation_id=?").bind(review.importId),
    db.prepare(`INSERT INTO native_directory_existing_import_local_receipts(import_id,record_id,execution_id,mutation_id,created_at)
      VALUES(?,?,?,?,?)`).bind(review.importId, review.nativeRecordId, executionId, review.importId, now),
    db.prepare(`INSERT INTO native_directory_existing_import_identity_translations(import_id,source_id,record_kind,classic_record_id,
      native_record_id,public_id,created_at) VALUES(?,?,?,?,?,?,?)`).bind(review.importId, review.sourceId, review.kind,
      review.recordId, review.nativeRecordId, review.publicId, now),
    db.prepare(`INSERT INTO native_directory_existing_import_events(import_id,state,detail_json) VALUES(?,'local_imported',?)`)
      .bind(review.importId, JSON.stringify({ recordId: review.nativeRecordId, classicRecordId: review.recordId })),
  );
  try { await db.batch(statements); }
  catch { return { status: "blocked", reason: "authority_or_atomic_write" }; }
  return { status: "imported", recordId: review.nativeRecordId, replayed: false };
}
