import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare | undefined;

async function fixture(): Promise<D1Database> {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  const database = await runtime.getD1Database("OPS_DB") as D1Database;
  await database.batch([
    database.prepare("PRAGMA foreign_keys = ON"),
    database.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY)"),
    database.prepare("CREATE TABLE client_onboarding_handoffs(command_id TEXT PRIMARY KEY,actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id))"),
    database.prepare(`CREATE TABLE client_onboarding_reveal_audit(
      reveal_id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES client_onboarding_handoffs(command_id),
      actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id),actor_access_subject TEXT NOT NULL,
      auth_verified_until TEXT NOT NULL,revealed_at TEXT NOT NULL)`),
    database.prepare("INSERT INTO native_staff_admissions(staff_id) VALUES('issuer')"),
    database.prepare("INSERT INTO client_onboarding_handoffs(command_id,actor_staff_id) VALUES('empty-command','issuer'),('many-command','issuer')"),
  ]);
  return database;
}

afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

describe("0140 client onboarding one-time reveal migration", () => {
  it("leaves empty history empty and deterministically consumes the earliest prior reveal", async () => {
    const database = await fixture();
    const rows = [
      ["00000000-0000-4000-8000-0000000000a2", "2026-01-02T00:00:00.000Z"],
      ["00000000-0000-4000-8000-0000000000a3", "2026-01-03T00:00:00.000Z"],
      ["00000000-0000-4000-8000-0000000000a1", "2026-01-02T00:00:00.000Z"],
    ] as const;
    await database.batch(rows.map(([revealId, revealedAt]) => database.prepare(`INSERT INTO client_onboarding_reveal_audit
      (reveal_id,command_id,actor_staff_id,actor_access_subject,auth_verified_until,revealed_at)
      VALUES(?,?,?,'access|issuer','2099-01-01T00:00:00.000Z',?)`).bind(revealId, "many-command", "issuer", revealedAt)));
    const migration = readFileSync(new URL("../migrations/0140_client_onboarding_one_time_reveal.sql", import.meta.url), "utf8");
    await database.batch(splitD1MigrationStatements(migration).map(statement => database.prepare(statement)));
    expect(await database.prepare("SELECT count(*) n FROM client_onboarding_reveal_consumptions WHERE command_id='empty-command'").first("n")).toBe(0);
    expect(await database.prepare("SELECT reveal_id,consumed_at FROM client_onboarding_reveal_consumptions WHERE command_id='many-command'").first())
      .toMatchObject({ reveal_id: rows[2][0], consumed_at: rows[2][1] });
    expect(await database.prepare("SELECT count(*) n FROM client_onboarding_reveal_consumptions WHERE command_id='many-command'").first("n")).toBe(1);
  });
});
