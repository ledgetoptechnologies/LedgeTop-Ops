import type { AuthenticatedNativeStaffWithAdmissionVersion } from './native-staff-auth';
import { isNativeAccessSubject } from './native-access-subject';
import { assertCurrentStaffLogin, snapshotStaffLoginProof, type StaffLoginProof } from './staff-login-bindings';

export type EmployeeReadAuthority = Readonly<{
  gatewayId: string; rootId: string; rootGeneration: number; rootFingerprint: string;
  staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number;
  grantId: string; grantGeneration: number; verifiedUntil: string;
  verifiedLogin?: StaffLoginProof;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STAFF = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const keys = ['gatewayId', 'rootId', 'rootGeneration', 'rootFingerprint', 'staffId', 'accessSubject', 'admissionVersion',
  'profileVersion', 'grantId', 'grantGeneration', 'verifiedUntil'] as const;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === names.length && own.every(name => typeof name === 'string' && names.includes(name)
    && Object.getOwnPropertyDescriptor(value, name)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, name)!, 'value'));
}
function validUntil(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) > Date.now();
}
function validProof(value: unknown): value is EmployeeReadAuthority {
  const fields = value && typeof value === 'object' && Object.hasOwn(value, 'verifiedLogin') ? [...keys, 'verifiedLogin'] : keys;
  if (!exact(value, fields)) return false;
  const login = Object.hasOwn(value, 'verifiedLogin') ? snapshotStaffLoginProof(value.verifiedLogin) : undefined;
  return (login === undefined || !!login && login.kind === 'alternate' && login.staffId === value.staffId
      && login.canonicalSubject === value.accessSubject && login.expiresAt * 1000 >= Date.parse(String(value.verifiedUntil)))
    && typeof value.gatewayId === 'string' && UUID.test(value.gatewayId)
    && typeof value.rootId === 'string' && UUID.test(value.rootId) && positive(value.rootGeneration)
    && typeof value.rootFingerprint === 'string' && SHA256.test(value.rootFingerprint)
    && typeof value.staffId === 'string' && STAFF.test(value.staffId) && isNativeAccessSubject(value.accessSubject)
    && positive(value.admissionVersion) && positive(value.profileVersion) && typeof value.grantId === 'string' && UUID.test(value.grantId)
    && positive(value.grantGeneration) && validUntil(value.verifiedUntil);
}

function exactAuthenticated(value: unknown): value is AuthenticatedNativeStaffWithAdmissionVersion {
  const fields = value && typeof value === 'object' && Object.hasOwn(value, 'verifiedLogin')
    ? ['identity', 'verifiedUntil', 'admissionVersion', 'verifiedLogin'] : ['identity', 'verifiedUntil', 'admissionVersion'];
  if (!exact(value, fields)
    || !exact(value.identity, ['kind', 'staffId', 'verifiedAccessSubject', 'email', 'displayName', 'profileVersion'])) return false;
  if (!Object.hasOwn(value, 'verifiedLogin')) return true;
  const login = snapshotStaffLoginProof(value.verifiedLogin);
  return !!login && login.kind === 'alternate' && login.staffId === value.identity.staffId
    && login.canonicalEmail === value.identity.email && login.canonicalSubject === value.identity.verifiedAccessSubject
    && login.expiresAt * 1000 >= Date.parse(String(value.verifiedUntil));
}

type Row = EmployeeReadAuthority & { email: string; expiresAt: number };
const query = `SELECT root.gateway_id gatewayId,root.root_id rootId,root.root_generation rootGeneration,root.root_fingerprint rootFingerprint,
  profile.staff_id staffId,admission.bound_access_subject accessSubject,admission.version admissionVersion,profile.version profileVersion,
  allowed.grant_id grantId,allowed.grant_generation grantGeneration,profile.login_email email,allowed.expires_at expiresAt
  FROM ops_employee_read_roots root
  JOIN ops_employee_read_grants allowed ON allowed.root_id=root.root_id AND allowed.root_generation=root.root_generation
    AND allowed.root_fingerprint=root.root_fingerprint AND allowed.effect='allow' AND allowed.active=1 AND allowed.expires_at>unixepoch()
  JOIN native_staff_admissions admission ON admission.staff_id=allowed.staff_id AND admission.active=1
    AND admission.bound_access_subject=allowed.access_subject AND admission.version=allowed.admission_version
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN staff_users staff ON staff.id=profile.staff_id AND staff.status='active' AND staff.access_subject=admission.bound_access_subject
  WHERE root.status='active' AND root.root_id=? AND profile.staff_id=? AND admission.bound_access_subject=?
    AND admission.version=? AND profile.version=?
    AND NOT EXISTS(SELECT 1 FROM ops_employee_read_grants denied WHERE denied.root_id=root.root_id
      AND denied.root_generation=root.root_generation AND denied.root_fingerprint=root.root_fingerprint
      AND denied.staff_id=profile.staff_id AND denied.access_subject=admission.bound_access_subject AND denied.admission_version=admission.version
      AND denied.active=1 AND denied.effect='deny' AND denied.expires_at>unixepoch())`;

/** A verified human identity is necessary but never grants a managed root.
 * No role, directory permission, legacy membership or email match grants bytes. */
export async function resolveEmployeeReadAuthority(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion, rootId: string, exactGrantId?: string): Promise<EmployeeReadAuthority | null> {
  try {
    if (typeof rootId !== 'string' || !UUID.test(rootId) || (exactGrantId !== undefined && (typeof exactGrantId !== 'string' || !UUID.test(exactGrantId)))
      || !exactAuthenticated(authenticated)) return null;
    const identity = authenticated.identity;
    if (identity.kind !== 'native' || typeof identity.staffId !== 'string' || !STAFF.test(identity.staffId)
      || !isNativeAccessSubject(identity.verifiedAccessSubject) || !positive(identity.profileVersion)
      || !positive(authenticated.admissionVersion) || !validUntil(authenticated.verifiedUntil)
      || typeof identity.email !== 'string' || identity.email !== identity.email.trim().toLowerCase()
      || !/^[^\s@]+@[^\s@]+$/u.test(identity.email) || /\p{C}/u.test(identity.email)) return null;
    // Trusted input may be mutable test/caller data: capture it before any await.
    const login = authenticated.verifiedLogin ? snapshotStaffLoginProof(authenticated.verifiedLogin)! : undefined;
    const input = Object.freeze({ rootId, staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
      admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion, email: identity.email, verifiedUntil: authenticated.verifiedUntil });
    if (login && !await assertCurrentStaffLogin(database, login)) return null;
    const row = await database.withSession('first-primary').prepare(query + (exactGrantId === undefined ? '' : ' AND allowed.grant_id=?') + ' ORDER BY allowed.grant_id LIMIT 1')
      .bind(input.rootId, input.staffId, input.accessSubject, input.admissionVersion, input.profileVersion, ...(exactGrantId === undefined ? [] : [exactGrantId])).first<Row>();
    if (!row || row.email !== input.email || !positive(row.expiresAt) || row.expiresAt > 253402300799) return null;
    const proof = Object.freeze({ gatewayId: row.gatewayId, rootId: row.rootId, rootGeneration: row.rootGeneration, rootFingerprint: row.rootFingerprint,
      staffId: row.staffId, accessSubject: row.accessSubject, admissionVersion: row.admissionVersion, profileVersion: row.profileVersion,
      grantId: row.grantId, grantGeneration: row.grantGeneration,
      verifiedUntil: new Date(Math.min(Date.parse(input.verifiedUntil), row.expiresAt * 1000)).toISOString(),
      ...(login ? { verifiedLogin: login } : {}) });
    return validProof(proof) && validUntil(input.verifiedUntil)
      && (!login || await assertCurrentStaffLogin(database, login)) ? proof : null;
  } catch { return null; }
}

/** Fresh primary recheck after the backend await and immediately before handoff.
 * A replaced grant cannot rescue a proof issued under a revoked grant ID. */
export async function recheckEmployeeReadAuthority(database: D1Database, proof: EmployeeReadAuthority): Promise<boolean> {
  try {
    if (!validProof(proof)) return false;
    const login = proof.verifiedLogin ? snapshotStaffLoginProof(proof.verifiedLogin)! : undefined;
    const input = Object.freeze({ ...proof, ...(login ? { verifiedLogin: login } : {}) });
    if (login && !await assertCurrentStaffLogin(database, login)) return false;
    const row = await database.withSession('first-primary').prepare(query + ' AND allowed.grant_id=? AND allowed.grant_generation=? LIMIT 1')
      .bind(input.rootId, input.staffId, input.accessSubject, input.admissionVersion, input.profileVersion, input.grantId, input.grantGeneration).first<Row>();
    return !!row && row.gatewayId === input.gatewayId && row.rootGeneration === input.rootGeneration
      && row.rootFingerprint === input.rootFingerprint && positive(row.expiresAt) && row.expiresAt * 1000 > Date.now() && validUntil(input.verifiedUntil)
      && (!login || await assertCurrentStaffLogin(database, login));
  } catch { return false; }
}

/** Discovery is scoped to this admitted person, never a global root inventory.
 * null means unavailable/invalid/over capacity; an empty array means no grants.
 * Callers must still resolve and recheck authority for each later operation. */
export async function listEmployeeReadRoots(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion): Promise<readonly Readonly<{ rootId: string; gatewayId: string; displayName: string }>[] | null> {
  try {
    if (!exactAuthenticated(authenticated)) return null;
    const identity = Object.freeze({ ...authenticated.identity });
    const login = authenticated.verifiedLogin ? snapshotStaffLoginProof(authenticated.verifiedLogin)! : undefined;
    const input = Object.freeze({ ...authenticated, identity, ...(login ? { verifiedLogin: login } : {}) });
    if (identity.kind !== 'native' || typeof identity.staffId !== 'string' || !STAFF.test(identity.staffId)
      || !isNativeAccessSubject(identity.verifiedAccessSubject) || !positive(identity.profileVersion)
      || !positive(input.admissionVersion) || !validUntil(input.verifiedUntil)
      || typeof identity.email !== 'string' || identity.email !== identity.email.trim().toLowerCase()
      || !/^[^\s@]+@[^\s@]+$/u.test(identity.email) || /\p{C}/u.test(identity.email)) return null;
    const currentIdentity = () => database.withSession('first-primary').prepare(`SELECT profile.staff_id id
      FROM native_staff_profiles profile JOIN native_staff_admissions admission ON admission.staff_id=profile.staff_id
      JOIN staff_users staff ON staff.id=profile.staff_id AND staff.status='active' AND staff.access_subject=admission.bound_access_subject
      WHERE profile.staff_id=? AND profile.version=? AND profile.login_email=? AND admission.active=1
        AND admission.bound_access_subject=? AND admission.version=?`)
      .bind(identity.staffId, identity.profileVersion, identity.email, identity.verifiedAccessSubject, input.admissionVersion).first<{ id: string }>();
    if (login && !await assertCurrentStaffLogin(database, login)) return null;
    if (!await currentIdentity() || !validUntil(input.verifiedUntil)) return null;
    const result = await database.withSession('first-primary').prepare(`SELECT DISTINCT root.root_id rootId
      FROM ops_employee_read_grants allowed JOIN ops_employee_read_roots root ON root.root_id=allowed.root_id
      JOIN native_staff_admissions admission ON admission.staff_id=allowed.staff_id AND admission.active=1
        AND admission.bound_access_subject=allowed.access_subject AND admission.version=allowed.admission_version
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      JOIN staff_users staff ON staff.id=profile.staff_id AND staff.status='active' AND staff.access_subject=admission.bound_access_subject
      WHERE allowed.staff_id=? AND allowed.access_subject=? AND allowed.admission_version=?
        AND profile.version=? AND profile.login_email=? AND root.status='active' AND allowed.active=1
        AND allowed.effect='allow' AND allowed.expires_at>unixepoch()
        AND allowed.root_generation=root.root_generation AND allowed.root_fingerprint=root.root_fingerprint
      ORDER BY root.root_id LIMIT 101`)
      .bind(identity.staffId, identity.verifiedAccessSubject, input.admissionVersion, identity.profileVersion, identity.email)
      .all<{ rootId: string }>();
    if (!result.success || result.results.length > 100 || !validUntil(input.verifiedUntil)) return null;
    const proofs: EmployeeReadAuthority[] = [];
    for (const candidate of result.results) {
      const proof = await resolveEmployeeReadAuthority(database, input, candidate.rootId);
      if (proof) proofs.push(proof);
    }
    const roots: Readonly<{ rootId: string; gatewayId: string; displayName: string }>[] = [];
    for (const proof of proofs) {
      const row = await database.withSession('first-primary').prepare(`SELECT display_name displayName FROM ops_employee_read_roots
        WHERE root_id=? AND gateway_id=? AND root_generation=? AND root_fingerprint=? AND status='active'`)
        .bind(proof.rootId, proof.gatewayId, proof.rootGeneration, proof.rootFingerprint).first<{ displayName: string }>();
      if (!row || typeof row.displayName !== 'string' || row.displayName.length > 160 || !row.displayName.trim() || /\p{C}/u.test(row.displayName)) return null;
      roots.push(Object.freeze({ rootId: proof.rootId, gatewayId: proof.gatewayId, displayName: row.displayName }));
    }
    for (const proof of proofs) if (!await recheckEmployeeReadAuthority(database, proof)) return null;
    // Even an empty listing must distinguish no grants from a session whose
    // native admission/profile changed while the candidate read was pending.
    if (!await currentIdentity() || !validUntil(input.verifiedUntil)
      || login && !await assertCurrentStaffLogin(database, login)) return null;
    return Object.freeze(roots);
  } catch { return null; }
}
