import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("portal identity history read-index upgrade", () => {
  it("upgrades populated production tables without data changes and uses exact history indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const directory = new URL("../../client/migrations/", import.meta.url);
      const target = "0152_portal_identity_read_indexes.sql";
      for (const name of readdirSync(fileURLToPath(directory)).filter(name => /^\d+_.+\.sql$/.test(name) && name < target).sort())
        db.exec(readFileSync(new URL(name, directory), "utf8"));
      db.exec(`
        INSERT INTO portal_v2_identities(id,issuer,subject,verified_email)
          VALUES('history-identity','https://issuer.example.test','history-person','history@example.test');
        INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name)
          VALUES('history-workspace','organization','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','History workspace');
        INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
          VALUES('history-membership','history-workspace','history-identity','project_alpha');
        WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<119)
          INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at,created_at)
          SELECT printf('history-invite-%04d',n),'history-workspace',printf('%043d',n),' History@Example.Test ',
            'history-identity','2099-01-01','2026-08-01' FROM ids;
        WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<119)
          INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type,created_at)
          SELECT printf('history-rule-%04d',n),'history-workspace','history-identity','delivery.view','project',
            'project-'||n,'operations','2026-08-01' FROM ids;
        INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,normalized_email,reason_code,created_by_actor_type,created_by_actor_id)
          VALUES('history-email','email',' History@Example.Test ','test','staff','operator');
        INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,issuer,subject,reason_code,created_by_actor_type,created_by_actor_id)
          VALUES('history-subject','issuer_subject','https://issuer.example.test','history-person','test','staff','operator');
      `);
      const queries = [
        { index: "idx_portal_invitations_email_history", sql: `SELECT id FROM portal_v2_invitations
          WHERE workspace_id='history-workspace' AND lower(trim(invited_email))='history@example.test'
          ORDER BY created_at DESC,id DESC LIMIT 1` },
        { index: "idx_portal_entitlements_identity_history", sql: `SELECT id FROM portal_v2_entitlements
          WHERE workspace_id='history-workspace' AND identity_id='history-identity'
            AND (created_at,id)<('2026-08-01','history-rule-0100')
          ORDER BY created_at DESC,id DESC LIMIT 25` },
        { index: "idx_portal_eligibility_email_history", sql: `SELECT id FROM portal_v2_identity_eligibility_blocks
          WHERE match_type='email' AND lower(trim(normalized_email))='history@example.test'
          ORDER BY created_at DESC,id DESC LIMIT 25` },
        { index: "idx_portal_eligibility_subject_history", sql: `SELECT id FROM portal_v2_identity_eligibility_blocks
          WHERE match_type='issuer_subject' AND issuer='https://issuer.example.test' AND subject='history-person'
          ORDER BY created_at DESC,id DESC LIMIT 25` },
      ];
      const beforeResults = queries.map(query => db.prepare(query.sql).all());
      const beforeInvitationPlan = db.prepare(`EXPLAIN QUERY PLAN ${queries[0]!.sql}`).all();
      expect(beforeInvitationPlan.some(row => /TEMP B-TREE/.test(String(row.detail)))).toBe(true);
      const tables = ["portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships",
        "portal_v2_entitlements", "portal_v2_invitations", "portal_v2_identity_eligibility_blocks"];
      const beforeRows = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
      const beforeTriggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
      const migration = readFileSync(new URL(target, directory), "utf8");
      db.exec(migration);
      db.exec(migration); // Additive and safe to replay; never rebuild authority tables.
      expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(beforeRows);
      expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).toEqual(beforeTriggers);
      expect(queries.map(query => db.prepare(query.sql).all())).toEqual(beforeResults);
      for (const query of queries) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all();
        expect(plan.some(row => String(row.detail).includes(query.index)), JSON.stringify(plan)).toBe(true);
        expect(plan.some(row => /TEMP B-TREE/.test(String(row.detail))), JSON.stringify(plan)).toBe(false);
      }
      const blockSummaryPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM portal_v2_identity_eligibility_blocks
        WHERE match_type='email' AND lower(trim(normalized_email))='history@example.test' AND status='active'
          AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`).all();
      expect(blockSummaryPlan.some(row => String(row.detail).includes("idx_portal_eligibility_email_history"))).toBe(true);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { db.close(); }
  });
});
