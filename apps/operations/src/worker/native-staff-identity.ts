import { isNativeAccessSubject } from "./native-access-subject";

export type NativeStaffIdentityInput = {
  verifiedEmail: string;
  verifiedAccessSubject: string;
};

export type NativeStaffIdentity = Readonly<{
  kind: "native";
  staffId: string;
  verifiedAccessSubject: string;
  email: string;
  displayName: string;
  profileVersion: number;
}>;

export type NativeStaffIdentityWithAdmissionVersion = Readonly<{
  identity: NativeStaffIdentity;
  admissionVersion: number;
}>;

type IdentityRow = {
  staff_id: unknown;
  bound_access_subject: unknown;
  login_email: unknown;
  display_name: unknown;
  version: unknown;
  admission_version: unknown;
};

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

function isPlainDataInput(value: unknown): value is NativeStaffIdentityInput {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== 2 || ownKeys.some(key => typeof key !== "string")) return false;
  const keys = ownKeys as string[];
  if (keys.slice().sort().join(",") !== "verifiedAccessSubject,verifiedEmail") return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function validEmail(value: string): boolean {
  return value.length >= 3 && value.length <= 254 && value === value.trim()
    && value === value.toLowerCase() && !value.includes("\0") && EMAIL.test(value);
}

function validRow(row: IdentityRow): row is IdentityRow & {
  staff_id: string; bound_access_subject: string; login_email: string; display_name: string;
  version: number; admission_version: number;
} {
  return typeof row.staff_id === "string" && SUBJECT.test(row.staff_id)
    && typeof row.bound_access_subject === "string" && isNativeAccessSubject(row.bound_access_subject)
    && typeof row.login_email === "string" && validEmail(row.login_email)
    && typeof row.display_name === "string" && row.display_name.length >= 1 && row.display_name.length <= 160
    && row.display_name.trim().length >= 1 && !row.display_name.includes("\0")
    && typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 1
    && typeof row.admission_version === "number" && Number.isSafeInteger(row.admission_version)
    && row.admission_version >= 1;
}

/** Resolves already-verified Access identity data against native authority.
 * This function does not decode a token and never provisions or binds by email. */
export async function resolveNativeStaffIdentity(
  database: D1Database,
  input: NativeStaffIdentityInput,
): Promise<NativeStaffIdentity | null> {
  const resolved = await resolveNativeStaffIdentityWithAdmissionVersion(database, input);
  return resolved?.identity ?? null;
}

/** Captures the active admission version and identity from the same primary read.
 * Consumers must still recheck this version inside their mutation transaction. */
export async function resolveNativeStaffIdentityWithAdmissionVersion(
  database: D1Database,
  input: NativeStaffIdentityInput,
): Promise<NativeStaffIdentityWithAdmissionVersion | null> {
  if (!isPlainDataInput(input)
    || typeof input.verifiedEmail !== "string" || !validEmail(input.verifiedEmail)
    || typeof input.verifiedAccessSubject !== "string" || !isNativeAccessSubject(input.verifiedAccessSubject)) {
    throw new Error("invalid_native_staff_identity_input");
  }

  // Copy every trusted scalar before the first asynchronous boundary.
  const snapshot = Object.freeze({
    verifiedEmail: input.verifiedEmail,
    verifiedAccessSubject: input.verifiedAccessSubject,
  });
  const session = database.withSession("first-primary");
  const result = await session.prepare(`SELECT profile.staff_id,admission.bound_access_subject,
      profile.login_email,profile.display_name,profile.version,admission.version AS admission_version
    FROM native_staff_profiles profile
    JOIN native_staff_admissions admission ON admission.staff_id=profile.staff_id
      AND admission.active=1
      AND admission.bound_access_subject=?
    WHERE profile.login_email=? COLLATE NOCASE
    LIMIT 2`).bind(snapshot.verifiedAccessSubject, snapshot.verifiedEmail).all<IdentityRow>();
  if (result.results.length !== 1) return null;
  const row = result.results[0];
  if (!row || !validRow(row)
    || row.bound_access_subject !== snapshot.verifiedAccessSubject
    || row.login_email !== snapshot.verifiedEmail) return null;
  const identity: NativeStaffIdentity = Object.freeze({ kind: "native", staffId: row.staff_id,
    verifiedAccessSubject: snapshot.verifiedAccessSubject, email: row.login_email,
    displayName: row.display_name, profileVersion: row.version });
  return Object.freeze({ identity, admissionVersion: row.admission_version });
}
