import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({
  authenticateNativeStaffWithAdmissionVersion: auth.current,
}));
import {
  mutateClientHubNativeLifecycle,
  nativeLifecyclePrepareSchema,
  nativeLifecycleSubmitSchema,
  nativeLifecycleRefreshPrepareSchema,
  nativeLifecycleRefreshSubmitSchema,
} from "../src/worker/client-hub-native-project-lifecycle";
const commandId = "11111111-1111-4111-8111-111111111111",
  refreshCommandId = "22222222-2222-4222-8222-222222222222";
const context = {
  root: {
    root_namespace: "business",
    kind: "organization",
    source_id: "project-alpha:test",
    public_id: "native-org",
  },
  contextVersion: "current-context",
};
const principal = {
  id: "staff-native",
  email: "native@example.test",
  accessSubject: "native-access",
};
const input = {
  expectedContextVersion: context.contextVersion,
  commandId,
  externalProjectId: "ops/project",
  action: "archive",
};
beforeEach(() => auth.current.mockReset());
describe("native project lifecycle HTTP intent and authentication boundary", () => {
  it("accepts only archive/restore intent, with no caller-supplied actor/destination/PA body", () => {
    expect(nativeLifecyclePrepareSchema.safeParse(input).success).toBe(true);
    for (const injected of [
      { ...input, action: "complete" },
      { ...input, action: "cancel" },
      { ...input, actor: { staffId: "forged" } },
      { ...input, sourceId: "project-alpha:sibling" },
      { ...input, body: { expectedRevision: "1" } },
      { ...input, applicationId: commandId },
      { ...input, financial: true },
    ])
      expect(nativeLifecyclePrepareSchema.safeParse(injected).success).toBe(
        false,
      );
  });
  it("requires exact reviewed hashes and explicit reconciliation decisions for both POST types", () => {
    const submit = {
      expectedContextVersion: context.contextVersion,
      commandId,
      reviewSha256: "a".repeat(64),
      reconcile: false,
    };
    expect(nativeLifecycleSubmitSchema.safeParse(submit).success).toBe(true);
    expect(
      nativeLifecycleSubmitSchema.safeParse({ ...submit, reconcile: undefined })
        .success,
    ).toBe(false);
    expect(
      nativeLifecycleRefreshPrepareSchema.safeParse({
        expectedContextVersion: context.contextVersion,
        commandId,
        refreshCommandId,
        reviewSha256: "b".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      nativeLifecycleRefreshSubmitSchema.safeParse({
        ...submit,
        refreshCommandId,
      }).success,
    ).toBe(true);
    expect(
      nativeLifecycleRefreshSubmitSchema.safeParse({
        ...submit,
        refreshCommandId,
        body: { commandId: refreshCommandId },
      }).success,
    ).toBe(false);
  });
  it("rejects malformed/context-stale requests before native authentication or PA reads", async () => {
    const send = vi.fn<typeof fetch>();
    for (const body of [
      { ...input, expectedContextVersion: "stale" },
      { ...input, action: "cancel" },
    ])
      await expect(
        mutateClientHubNativeLifecycle(
          {} as never,
          new Request("https://ops.test/route"),
          principal as never,
          context as never,
          "prepare",
          body,
          send,
        ),
      ).rejects.toThrow();
    expect(auth.current).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("requires the real authenticated native actor to match the Operations principal", async () => {
    auth.current.mockResolvedValue({
      identity: {
        staffId: "another-staff",
        email: "another@example.test",
        verifiedAccessSubject: "another-access",
        profileVersion: 1,
      },
      admissionVersion: 1,
      verifiedUntil: "2999-01-01T00:00:00.000Z",
    });
    const send = vi.fn<typeof fetch>();
    await expect(
      mutateClientHubNativeLifecycle(
        { OPS_DB: {} } as never,
        new Request("https://ops.test/route"),
        principal as never,
        context as never,
        "prepare",
        input,
        send,
      ),
    ).rejects.toThrow(/identities must match/);
    expect(send).not.toHaveBeenCalled();
    expect(auth.current).toHaveBeenCalledOnce();
  });
  it("denies absent native session and non-business owner contexts before reads", async () => {
    auth.current.mockRejectedValue(new Error("native auth denied"));
    const send = vi.fn<typeof fetch>();
    await expect(
      mutateClientHubNativeLifecycle(
        { OPS_DB: {} } as never,
        new Request("https://ops.test/route"),
        principal as never,
        context as never,
        "prepare",
        input,
        send,
      ),
    ).rejects.toThrow("native auth denied");
    expect(send).not.toHaveBeenCalled();
    auth.current.mockReset();
    await expect(
      mutateClientHubNativeLifecycle(
        {} as never,
        new Request("https://ops.test/route"),
        principal as never,
        {
          ...context,
          root: { ...context.root, root_namespace: "portal" },
        } as never,
        "prepare",
        input,
        send,
      ),
    ).rejects.toThrow(/owner context/);
    expect(auth.current).not.toHaveBeenCalled();
  });
});
