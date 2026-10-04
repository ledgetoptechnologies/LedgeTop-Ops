import { z } from "zod";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const id = z.string().min(1).max(191).refine(value => value === value.trim());
const key = z.string().min(16).max(128).refine(value => value === value.trim());
const commandSchema = z.object({
  mutationId: id,
  idempotencyKey: key,
  customerRecordId: id,
  serviceId: id,
  desiredState: z.enum(["active", "revoked"]),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export type CustomerServiceEnrollmentCommand = z.infer<typeof commandSchema>;
export type CustomerServiceEnrollmentReceipt = Readonly<{
  mutationId: string;
  customerRecordId: string;
  serviceId: string;
  state: "active" | "revoked";
  revision: number;
  replayed: boolean;
}>;

type Saved = {
  mutation_id: string;
  request_fingerprint: string;
  customer_record_id: string;
  service_id: string;
  desired_state: "active" | "revoked";
  expected_revision: number;
  result_revision: number;
};

const denied = (): never => { throw Error("customer_service_enrollment_denied"); };
const savedSql = `SELECT mutation_id,request_fingerprint,customer_record_id,service_id,desired_state,expected_revision,result_revision
  FROM operations_customer_service_enrollment_mutations WHERE actor_staff_id=? AND idempotency_key=?`;

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function currentGrantGeneration(db: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion,
  customerRecordId: string): Promise<number | null> {
  return db.withSession("first-primary").prepare(`SELECT generation.generation
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.version=?
      AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
        WHERE allow_row.staff_id=admission.staff_id AND allow_row.permission='directory.enrollment.manage'
          AND allow_row.effect='allow' AND allow_row.active=1
          AND (allow_row.scope_kind='global' OR (allow_row.scope_kind='resource' AND allow_row.resource_id=?)
            OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=? AND assignment.staff_id=admission.staff_id AND assignment.active=1))
            OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
              WHERE scope.record_id=? AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
            OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
              JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id AND division.active=1
              WHERE scope.record_id=? AND scope.active=1 AND scope.division_id=allow_row.division_id))))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
        WHERE deny_row.staff_id=admission.staff_id AND deny_row.permission='directory.enrollment.manage'
          AND deny_row.effect='deny' AND deny_row.active=1
          AND (deny_row.scope_kind='global' OR (deny_row.scope_kind='resource' AND deny_row.resource_id=?)
            OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=? AND assignment.staff_id=admission.staff_id AND assignment.active=1))
            OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
              WHERE scope.record_id=? AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
            OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
              JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id AND division.active=1
              WHERE scope.record_id=? AND scope.active=1 AND scope.division_id=deny_row.division_id))))`)
    .bind(actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion,
      customerRecordId, customerRecordId, customerRecordId, customerRecordId,
      customerRecordId, customerRecordId, customerRecordId, customerRecordId).first<number>("generation");
}

function matches(row: Saved, command: CustomerServiceEnrollmentCommand, fingerprint: string): boolean {
  return row.request_fingerprint === fingerprint && row.mutation_id === command.mutationId
    && row.customer_record_id === command.customerRecordId && row.service_id === command.serviceId
    && row.desired_state === command.desiredState && row.expected_revision === command.expectedRevision
    && row.result_revision === command.expectedRevision + 1;
}
function receipt(row: Saved, replayed: boolean): CustomerServiceEnrollmentReceipt {
  return { mutationId: row.mutation_id, customerRecordId: row.customer_record_id, serviceId: row.service_id,
    state: row.desired_state, revision: row.result_revision, replayed };
}

/** Private Operations writer. It creates no portal, content, financial, or PA authorization. */
export async function writeCustomerServiceEnrollment(db: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion,
  raw: unknown): Promise<CustomerServiceEnrollmentReceipt> {
  const parsed = commandSchema.safeParse(raw);
  const verifiedUntil = Date.parse(actor.verifiedUntil);
  if (!parsed.success || !Number.isFinite(verifiedUntil) || verifiedUntil <= Date.now()) return denied();
  const command = parsed.data;
  const generation = await currentGrantGeneration(db, actor, command.customerRecordId);
  if (!Number.isSafeInteger(generation) || generation === null || generation < 1) return denied();
  const fingerprint = await sha256(JSON.stringify(["ops-customer-service-enrollment-v1", command.idempotencyKey,
    command.customerRecordId, command.serviceId, command.desiredState, command.expectedRevision, actor.identity.staffId]));
  const session = db.withSession("first-primary");
  const prior = await session.prepare(savedSql).bind(actor.identity.staffId, command.idempotencyKey).first<Saved>();
  if (prior) return matches(prior, command, fingerprint) ? receipt(prior, true) : denied();
  const mutation = session.prepare(`INSERT INTO operations_customer_service_enrollment_mutations
    (mutation_id,actor_staff_id,authorized_access_subject,authorized_admission_version,authorized_profile_version,authorized_grant_generation,
      idempotency_key,request_fingerprint,customer_record_id,service_id,desired_state,expected_revision,result_revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(command.mutationId, actor.identity.staffId, actor.identity.verifiedAccessSubject,
      actor.admissionVersion, actor.identity.profileVersion, generation, command.idempotencyKey, fingerprint,
      command.customerRecordId, command.serviceId, command.desiredState, command.expectedRevision, command.expectedRevision + 1);
  const head = command.expectedRevision === 0
    ? session.prepare(`INSERT INTO operations_customer_service_enrollments(customer_record_id,service_id,state,revision,last_mutation_id)
        VALUES(?,?,?,?,?)`).bind(command.customerRecordId, command.serviceId, command.desiredState, 1, command.mutationId)
    : session.prepare(`UPDATE operations_customer_service_enrollments SET state=?,revision=?,last_mutation_id=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE customer_record_id=? AND service_id=? AND revision=?`)
      .bind(command.desiredState, command.expectedRevision + 1, command.mutationId,
        command.customerRecordId, command.serviceId, command.expectedRevision);
  try {
    const results = await session.batch([mutation, head]);
    if (command.expectedRevision > 0 && results[1]?.meta.changes !== 1) return denied();
  } catch {
    const raced = await session.prepare(savedSql).bind(actor.identity.staffId, command.idempotencyKey).first<Saved>();
    if (raced && matches(raced, command, fingerprint)) return receipt(raced, true);
    return denied();
  }
  const saved = await session.prepare(savedSql).bind(actor.identity.staffId, command.idempotencyKey).first<Saved>();
  if (!saved || !matches(saved, command, fingerprint)) return denied();
  return receipt(saved, false);
}
