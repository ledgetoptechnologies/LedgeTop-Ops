import { beforeEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const calls = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-recipient-authority", () => ({
  inspectOperationsPortalNativeRecipientIntent: calls.inspect,
  redeemOperationsPortalNativeRecipientIntent: vi.fn(),
}));
import { inspectOperationsPortalNativeRecipientEnrollmentRpc } from
  "../src/worker/operations-portal-native-recipient-enrollment-entrypoint";

const intentId = "10000000-0000-4000-8000-000000000000";
const targetId = "20000000-0000-4000-8000-000000000000";
const token = "a".repeat(64);
const expiresAt = "2099-01-01T00:00:00.000Z";

it("reads the aliased D1 display label as a scalar string in the canonical inspection envelope", async () => {
  calls.inspect.mockResolvedValue({ intentId, revision: 1, state: "issued",
    target: { targetId, targetRevision: 1, clientRecordId: "client:one" }, principal: null,
    recipientBindingId: null, expiresAt });
  const first = vi.fn().mockResolvedValue("Example Client");
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  const database = { withSession: vi.fn().mockReturnValue({ prepare }) } as unknown as D1Database;
  const wire = await inspectOperationsPortalNativeRecipientEnrollmentRpc({ OPS_DB: database, ENVIRONMENT: "staging",
    EXPECTED_HOST: "ops-staging.example.test", TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true" }, { protocolVersion: 1, intentId, opaqueToken: token });
  const parsed = JSON.parse(wire) as { target: { displayLabel: unknown } };
  expect(parsed.target.displayLabel).toBe("Example Client");
  expect(typeof parsed.target.displayLabel).toBe("string");
  expect(prepare.mock.calls[0]![0]).toContain("display_label");
  expect(bind).toHaveBeenCalledWith(intentId);
  expect(first).toHaveBeenCalledWith("display_label");
});
