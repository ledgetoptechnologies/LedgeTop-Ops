import sql from "../migrations/0097_client_portal_team_acl.sql?raw";
import { describe, expect, it } from "vitest";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { ClientPortalSession } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

interface Call { sql: string; binds: unknown[]; }

function recordingEnv(changes = 1): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sqlText: string) {
      const call: Call = { sql: sqlText, binds: [] };
      calls.push(call);
      const statement = {
        bind(...values: unknown[]) { call.binds = values; return statement; },
        async first<T>() { return { count: 1 } as T; },
        async all<T>() { return { results: [] as T[] }; },
        async run() { return { meta: { changes } }; },
      };
      return statement;
    },
    withSession() { return db; },
  };
  return { env: { DELIVERY_DB: db } as unknown as Env, calls };
}

const manager: ClientPortalSession = {
  accountId: "account-a", identityId: "manager-a", displayName: "Acme", role: "manager", canViewBilling: false,
};

describe("client portal team ACL migration", () => {
  it("adds explicit, default-deny membership and a non-delivering access sync outbox", () => {
    for (const table of ["client_account_members", "client_account_invitations", "client_member_project_grants", "client_access_sync_outbox"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("CHECK (role IN ('manager','member'))");
    expect(sql).toContain("CHECK (role='member')");
    expect(sql).toContain("can_view_billing INTEGER NOT NULL DEFAULT 0");
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
  });
});

describe("client portal manager enforcement", () => {
  it("will not let a manager revoke another manager or themselves", async () => {
    const value = recordingEnv();
    await expect(d1ClientPortalRepository.revokeMember(value.env, manager, manager.identityId)).resolves.toBe(false);
    expect(value.calls).toHaveLength(0);
  });

  it("revokes a member locally before any later Access reconciliation", async () => {
    const value = recordingEnv();
    await expect(d1ClientPortalRepository.revokeMember(value.env, manager, "member-a")).resolves.toBe(true);
    expect(value.calls[0]?.sql).toContain("role='member'");
    expect(value.calls[1]?.sql).toContain("UPDATE client_identity_links SET revoked_at=datetime('now')");
    expect(value.calls[2]?.sql).toContain("client.member.revoked");
  });

  it("allows a manager invitation only for a currently account-granted project", async () => {
    const value = recordingEnv();
    const invitation = await d1ClientPortalRepository.createInvitation(value.env, manager, { email: "new@example.com", projectIds: ["project-a"] });
    expect(invitation).toMatchObject({ email: "new@example.com", projectIds: ["project-a"] });
    expect(value.calls[0]?.sql).toContain("client_project_grants");
    expect(value.calls[1]?.sql).toContain("m.role='manager'");
    expect(value.calls[2]?.sql).toContain("client.invitation.created");
    expect(value.calls[3]?.sql).toContain("client_access_sync_outbox");
  });
});
