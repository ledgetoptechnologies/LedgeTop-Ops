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
beforeEach(() => vi.clearAllMocks());

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
    PUBLIC_BASE_URL: "https://ops-staging.example.test",
    CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true" }, { protocolVersion: 1, intentId, opaqueToken: token });
  const parsed = JSON.parse(wire) as { target: { displayLabel: unknown } };
  expect(parsed.target.displayLabel).toBe("Example Client");
  expect(typeof parsed.target.displayLabel).toBe("string");
  expect(prepare.mock.calls[0]![0]).toContain("display_label");
  expect(bind).toHaveBeenCalledWith(intentId);
  expect(first).toHaveBeenCalledWith("display_label");
});

it.each([
  { name: "disabled", change: { CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "false" } },
  { name: "unrecognized environment", change: { ENVIRONMENT: "development" } },
  { name: "wrong origin host", change: { PUBLIC_BASE_URL: "https://other.example.test" } },
  { name: "missing configured origin", change: { PUBLIC_BASE_URL: undefined } },
])("fails closed for $name", async ({ change }) => {
  const wire = await inspectOperationsPortalNativeRecipientEnrollmentRpc({ OPS_DB: {} as D1Database,
    ENVIRONMENT: "production", EXPECTED_HOST: "ops.example.test", TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    PUBLIC_BASE_URL: "https://ops.example.test",
    CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true", ...change },
  { protocolVersion: 1, intentId, opaqueToken: token });
  expect(JSON.parse(wire)).toEqual({ ok: false, protocolVersion: 1, code: "unavailable" });
  expect(calls.inspect).not.toHaveBeenCalled();
});
