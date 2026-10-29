import { describe, expect, it, vi } from "vitest";
import { openViewerWindow } from "@ltds/ui";
import { createViewerSessionIssuer } from "../src/client/viewer-window-launch";

const grant = (modelId: string) => ({
  modelId,
  grant: "11111111-1111-4111-8111-111111111111",
  grantExpiresAt: "2026-10-28T00:00:00.000Z",
  sessionTtlSeconds: 1800,
  redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
  embedUrl: "https://viewer.example.test/session/11111111-1111-4111-8111-111111111111",
});

describe("createViewerSessionIssuer", () => {
  it("keeps the same idempotency key after an ambiguous response and pins the first model", async () => {
    const issue = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary failure"), { status: 503 }))
      .mockResolvedValueOnce(grant("model-one"))
      .mockResolvedValueOnce(grant("model-one"));
    const issuer = createViewerSessionIssuer(issue);

    await expect(issuer()).rejects.toThrow("temporary failure");
    await expect(issuer()).resolves.toMatchObject({ modelId: "model-one" });
    await expect(issuer()).resolves.toMatchObject({ modelId: "model-one" });
    expect(issue.mock.calls[0]?.[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(issue.mock.calls[1]?.[0]).toBe(issue.mock.calls[0]?.[0]);
    expect(issue.mock.calls[2]?.[0]).not.toBe(issue.mock.calls[1]?.[0]);
  });

  it("uses a fresh key only after a definitive rejection, and refuses a changed model", async () => {
    const issue = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 409 }))
      .mockResolvedValueOnce(grant("model-one"))
      .mockResolvedValueOnce(grant("model-two"));
    const issuer = createViewerSessionIssuer(issue, "model-one");

    await expect(issuer()).rejects.toThrow("refused");
    await expect(issuer()).resolves.toMatchObject({ modelId: "model-one" });
    await expect(issuer()).rejects.toThrow("did not match");
    expect(issue.mock.calls[1]?.[0]).not.toBe(issue.mock.calls[0]?.[0]);
    expect(issue.mock.calls[2]?.[0]).not.toBe(issue.mock.calls[1]?.[0]);
  });

  it("still enforces a fixed model ID supplied by existing callers", async () => {
    const popup = {
      closed: false,
      document: { title: "", body: { textContent: "" } },
      close: vi.fn(),
      location: { replace: vi.fn() },
    };
    vi.stubGlobal("window", { open: vi.fn(() => popup) });
    try {
      await expect(openViewerWindow({
        modelId: "expected-model",
        title: "Viewer",
        issueSession: async () => grant("different-model"),
      })).rejects.toThrow("requested model");
      expect(popup.close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
