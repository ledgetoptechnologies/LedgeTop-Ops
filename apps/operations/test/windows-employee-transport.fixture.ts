import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { resolveNativeStaffIdentityWithAdmissionVersion } from "../src/worker/native-staff-identity";
import { provisionEmployeeRead } from "../src/worker/employee-read-provisioning";

export async function employeeTransportAuthority(rootId: string, gatewayId: string, fingerprint: string) {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}", d1Databases: ["DB"] });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0223").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, migrations), "utf8")).map(sql => db.prepare(sql)));
    async function person(name: string, owner = false) {
      const id = `synthetic-${name}`, email = `${name}@employee-transport.invalid`, subject = `synthetic-${name}-subject`;
      await db.batch([
        db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(id, email, id, subject),
        db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
        db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id),
      ]);
      if (owner) await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)")
        .bind(crypto.randomUUID(), id, id).run();
      const identity = await resolveNativeStaffIdentityWithAdmissionVersion(db, { verifiedEmail: email, verifiedAccessSubject: subject });
      if (!identity) throw Error("Synthetic native admission missing");
      return { ...identity, verifiedUntil: new Date(Date.now() + 600_000).toISOString() };
    }
    const owner = await person("owner", true), alice = await person("alice"), bob = await person("bob");
    const options = { gatewayIds: [gatewayId] };
    await provisionEmployeeRead(db, owner, { commandId: crypto.randomUUID(), kind: "register-root", rootId, gatewayId,
      rootFingerprint: fingerprint, displayName: "Synthetic PC container files" }, options);
    const grantId = crypto.randomUUID();
    await provisionEmployeeRead(db, owner, { commandId: crypto.randomUUID(), kind: "grant-read", rootId, rootGeneration: 1,
      rootFingerprint: fingerprint, grantId, targetStaffId: alice.identity.staffId,
      targetAccessSubject: alice.identity.verifiedAccessSubject, targetAdmissionVersion: alice.admissionVersion,
      expiresAt: Math.floor(Date.now() / 1000) + 600 }, options);
    return { runtime, db, alice, bob, async revoke() {
      await provisionEmployeeRead(db, owner, { commandId: crypto.randomUUID(), kind: "revoke-grant", grantId, expectedGeneration: 1 }, options);
    } };
  } catch (error) { await runtime.dispose(); throw error; }
}
