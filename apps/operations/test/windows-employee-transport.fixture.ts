import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { resolveNativeStaffIdentityWithAdmissionVersion } from "../src/worker/native-staff-identity";
import { provisionEmployeeRead } from "../src/worker/employee-read-provisioning";

const finalMigration = "0223_employee_read_provisioning.sql";
const inventorySha256 = "e60ada4d152c98a822c75e3caa86187b8558a6be944f14860c520fc2b098aa2a";
const lf = (source: string) => source.replace(/\r\n/gu, "\n");
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

// Freeze every source filename and LF-normalized byte hash before touching D1.
// The inventory itself is pinned independently, so edits to it require review.
function verifyMigrationInventory() {
  const raw = lf(readFileSync(new URL("./fixtures/windows-employee-transport-migrations-0223.json", import.meta.url), "utf8"));
  if (hash(raw) !== inventorySha256) throw Error("employee-transport-migration-inventory-pin");
  const inventory = JSON.parse(raw) as { migrations: { name: string; sha256: string }[] };
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0223").sort();
  if (names.length !== 223 || names.at(-1) !== finalMigration
    || JSON.stringify(names) !== JSON.stringify(inventory.migrations.map(entry => entry.name)))
    throw Error("employee-transport-migration-inventory-names");
  for (const entry of inventory.migrations) {
    const path = new URL(entry.name, directory);
    if (!lstatSync(path).isFile() || hash(lf(readFileSync(path, "utf8"))) !== entry.sha256)
      throw Error("employee-transport-migration-inventory-content");
  }
}

export async function employeeTransportAuthority(rootId: string, gatewayId: string, fingerprint: string) {
  verifyMigrationInventory();
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}", d1Databases: ["DB"] });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    await applyCanonicalChain(db, "operations", finalMigration, true);
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
