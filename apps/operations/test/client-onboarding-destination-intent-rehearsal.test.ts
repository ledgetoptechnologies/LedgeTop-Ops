import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const migration = readFileSync(new URL("./fixtures/client-onboarding-destination-intent.provisional.sql", import.meta.url), "utf8");
const technology = { sourceId: "project-alpha:secondary", businessAreaId: "area:t", divisionId: "division:t" };
const drone = { sourceId: "project-alpha:primary", businessAreaId: "area:d", divisionId: "division:d" };
const both = [technology, drone];
const scopes = both.map(({ businessAreaId, divisionId }) => ({ businessAreaId, divisionId }));
const hash = "a".repeat(64);
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE client_onboarding_issuance_commands (
    invitation_id TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL, scopes_json TEXT);
  CREATE TRIGGER client_onboarding_issuance_commands_no_update
    BEFORE UPDATE ON client_onboarding_issuance_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TABLE client_onboarding_decisions (invitation_id TEXT PRIMARY KEY, outcome TEXT NOT NULL);
  INSERT INTO client_onboarding_issuance_commands VALUES ('historical', '${hash}', NULL);`);
  db.exec(migration);
});
afterEach(() => db.close());

function issue(intent: unknown, scope: unknown = scopes) {
  db.prepare("INSERT INTO client_onboarding_issuance_commands VALUES ('new',?,?,?)")
    .run(hash, JSON.stringify(scope), JSON.stringify(intent));
}

it("preserves historical and new legacy writes that use the original column lists", () => {
  db.exec(`INSERT INTO client_onboarding_decisions (invitation_id,outcome) VALUES ('historical','approved');
    INSERT INTO client_onboarding_issuance_commands (invitation_id,request_sha256,scopes_json) VALUES ('legacy','${hash}',NULL);
    INSERT INTO client_onboarding_decisions (invitation_id,outcome) VALUES ('legacy','approved');`);
  expect(db.prepare("SELECT count(*) total FROM client_onboarding_decisions").get()?.total).toBe(2);
});

it("requires exact source-qualified scopes and blocks an old approval writer", () => {
  expect(() => issue([technology, { ...drone, businessAreaId: "other" }])).toThrow("onboarding destination scope mismatch");
  expect(() => issue([technology, { ...drone, sourceId: technology.sourceId }])).toThrow("onboarding destination scope mismatch");
  issue(both);
  expect(() => db.exec("UPDATE client_onboarding_issuance_commands SET destination_intent_json=NULL WHERE invitation_id='new'")).toThrow("immutable");
  expect(() => db.exec("INSERT INTO client_onboarding_decisions (invitation_id,outcome) VALUES ('new','approved')"))
    .toThrow("onboarding destination approval requires exact issuance");
  const approve = db.prepare("INSERT INTO client_onboarding_decisions VALUES ('new','approved',?)");
  expect(() => approve.run("b".repeat(64))).toThrow("onboarding destination approval requires exact issuance");
  expect(approve.run(hash).changes).toBe(1);
});

it("supports single selection and a transaction rollback after a later failure", () => {
  db.exec("BEGIN");
  issue([technology], [scopes[0]]);
  expect(() => db.exec("INSERT INTO client_onboarding_decisions (invitation_id,outcome) VALUES ('new','approved')"))
    .toThrow("onboarding destination approval requires exact issuance");
  db.exec("ROLLBACK");
  expect(db.prepare("SELECT 1 FROM client_onboarding_issuance_commands WHERE invitation_id='new'").get()).toBeUndefined();
});
