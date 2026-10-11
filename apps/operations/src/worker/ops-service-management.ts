import { z } from "zod";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { resolveCustomerServiceEnrollmentGrantGeneration, writeCustomerServiceEnrollment,
  type CustomerServiceEnrollmentReceipt } from "./ops-customer-service-enrollments";

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value === value.trim() && !value.includes("\0"));
const definitionSchema = z.object({ mutationId: text(191), idempotencyKey: text(128).min(16), serviceId: text(191),
  providerId: text(128), sourceId: text(128), sourceServiceId: text(191), displayName: text(160) }).strict();
const enrollmentSchema = z.object({ mutationId: text(191), idempotencyKey: text(128).min(16),
  customerRecordId: text(191), serviceId: text(191), desiredState: z.enum(["active", "revoked"]),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).strict();

type DefinitionInput = z.infer<typeof definitionSchema>;
type Saved = DefinitionInput & { request_fingerprint: string };
const denied = (): never => { throw Error("service_management_denied"); };
async function sha256(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
  .map(byte => byte.toString(16).padStart(2, "0")).join(""); }

async function generation(db: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion) {
  return db.withSession("first-primary").prepare(`SELECT generation.generation FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND role.role_id IN ('role-owner','role-admin') AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
        AND grant_row.permission='directory.enrollment.manage' AND grant_row.effect='allow'
        AND grant_row.scope_kind='global' AND grant_row.active=1)
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
        AND grant_row.permission='directory.enrollment.manage' AND grant_row.effect='deny'
        AND grant_row.scope_kind='global' AND grant_row.active=1)`)
    .bind(actor.identity.profileVersion, actor.identity.staffId, actor.identity.verifiedAccessSubject,
      actor.admissionVersion).first<number>("generation");
}

export async function createOperationsServiceDefinition(db: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, raw: unknown) {
  const parsed = definitionSchema.safeParse(raw), expiry = Date.parse(actor.verifiedUntil);
  if (!parsed.success || !Number.isFinite(expiry) || expiry <= Date.now()) return denied();
  const input = parsed.data, currentGeneration = await generation(db, actor);
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration === null || currentGeneration < 1) return denied();
  const fingerprint = await sha256(JSON.stringify(["ops-service-definition-v1", input, actor.identity.staffId]));
  const session = db.withSession("first-primary");
  const prior = await session.prepare(`SELECT mutation_id mutationId,idempotency_key idempotencyKey,service_id serviceId,
      provider_id providerId,source_id sourceId,source_service_id sourceServiceId,display_name displayName,request_fingerprint
    FROM operations_service_definition_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
    .bind(actor.identity.staffId, input.idempotencyKey).first<Saved>();
  if (prior) return prior.request_fingerprint === fingerprint && prior.mutationId === input.mutationId
    && prior.idempotencyKey === input.idempotencyKey && prior.serviceId === input.serviceId
    && prior.providerId === input.providerId && prior.sourceId === input.sourceId
    && prior.sourceServiceId === input.sourceServiceId && prior.displayName === input.displayName
    ? { serviceId: prior.serviceId, replayed: true } : denied();
  const mutation = session.prepare(`INSERT INTO operations_service_definition_mutations
    (mutation_id,actor_staff_id,authorized_access_subject,authorized_admission_version,authorized_profile_version,
      authorized_grant_generation,idempotency_key,request_fingerprint,service_id,provider_id,source_id,source_service_id,display_name)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.mutationId, actor.identity.staffId, actor.identity.verifiedAccessSubject,
      actor.admissionVersion, actor.identity.profileVersion, currentGeneration, input.idempotencyKey, fingerprint,
      input.serviceId, input.providerId, input.sourceId, input.sourceServiceId, input.displayName);
  const definition = session.prepare(`INSERT INTO operations_service_definitions
    (service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)`)
    .bind(input.serviceId, input.providerId, input.sourceId, input.sourceServiceId, input.displayName);
  try { await session.batch([mutation, definition]); } catch {
    const raced = await session.prepare(`SELECT mutation_id mutationId,idempotency_key idempotencyKey,service_id serviceId,
      provider_id providerId,source_id sourceId,source_service_id sourceServiceId,display_name displayName,request_fingerprint
      FROM operations_service_definition_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
      .bind(actor.identity.staffId, input.idempotencyKey).first<Saved>();
    if (raced?.request_fingerprint === fingerprint && raced.mutationId === input.mutationId
      && raced.idempotencyKey === input.idempotencyKey && raced.serviceId === input.serviceId
      && raced.providerId === input.providerId && raced.sourceId === input.sourceId
      && raced.sourceServiceId === input.sourceServiceId && raced.displayName === input.displayName)
      return { serviceId: raced.serviceId, replayed: true };
    return denied();
  }
  return { serviceId: input.serviceId, replayed: false };
}

export async function writeOperationsCustomerServiceEnrollment(db: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, raw: unknown): Promise<CustomerServiceEnrollmentReceipt> {
  const parsed = enrollmentSchema.safeParse(raw); if (!parsed.success) return denied();
  return writeCustomerServiceEnrollment(db, actor, parsed.data);
}

export async function canManageOperationsCustomerServices(db: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, customerRecordId: string) {
  const expiry = Date.parse(actor.verifiedUntil);
  if (!text(191).safeParse(customerRecordId).success || !Number.isFinite(expiry) || expiry <= Date.now()) return false;
  const generation = await resolveCustomerServiceEnrollmentGrantGeneration(db, actor, customerRecordId);
  return Number.isSafeInteger(generation) && generation !== null && generation >= 1;
}

export async function readOperationsServiceManagement(db: D1Database, customerRecordId: string) {
  if (!text(191).safeParse(customerRecordId).success) return denied();
  const session = db.withSession("first-primary");
  const [definitions, enrollments] = await Promise.all([
    session.prepare(`SELECT service_id serviceId,provider_id providerId,source_id sourceId,
      source_service_id sourceServiceId,display_name displayName FROM operations_service_definitions ORDER BY service_id LIMIT 101`).all(),
    session.prepare(`SELECT service_id serviceId,state,revision FROM operations_customer_service_enrollments
      WHERE customer_record_id=? ORDER BY service_id LIMIT 101`).bind(customerRecordId).all(),
  ]);
  if (!definitions.success || !enrollments.success || definitions.results.length > 100 || enrollments.results.length > 100) return denied();
  return { definitions: definitions.results, enrollments: enrollments.results };
}
