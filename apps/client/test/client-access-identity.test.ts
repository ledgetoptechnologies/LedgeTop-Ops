import { describe, expect, it } from "vitest";
import { clientAccessConfiguration, verifiedClientPrincipalFromAccessPayload } from "../src/worker/client-portal/access-identity";
import { clientAccessSyncSecretManifest, processClientAccessSyncBatch, type ClientAccessSyncCommand, type ClientAccessSyncOutbox } from "../src/worker/client-portal/access-sync";
import type { Env } from "../src/worker/types";

const configuration = { issuer: "https://team.cloudflareaccess.com", audience: "client-portal-aud" };

describe("Client Portal Cloudflare Access identity boundary", () => {
  it("requires a dedicated HTTPS issuer and audience", () => {
    expect(clientAccessConfiguration({ CLIENT_ACCESS_TEAM_DOMAIN: configuration.issuer, CLIENT_ACCESS_AUD: configuration.audience } as Env)).toEqual(configuration);
    expect(() => clientAccessConfiguration({ CLIENT_ACCESS_TEAM_DOMAIN: "http://team.example", CLIENT_ACCESS_AUD: configuration.audience } as Env)).toThrow("client-access-configuration-invalid");
    expect(() => clientAccessConfiguration({ CLIENT_ACCESS_TEAM_DOMAIN: configuration.issuer, CLIENT_ACCESS_AUD: "" } as Env)).toThrow("client-access-configuration-invalid");
  });

  it("maps only a verified human Access application assertion", () => {
    expect(verifiedClientPrincipalFromAccessPayload({
      iss: configuration.issuer, aud: configuration.audience, type: "app", sub: "access-subject", email: "Client@Example.com", email_verified: true, exp: 2_000_000_000,
    }, configuration)).toEqual({ issuer: configuration.issuer, subject: "access-subject", email: "client@example.com" });

    for (const payload of [
      { iss: configuration.issuer, aud: configuration.audience, type: "app", sub: "access-subject", email: "client@example.com", email_verified: false, exp: 2_000_000_000 },
      { iss: configuration.issuer, aud: configuration.audience, type: "org", sub: "access-subject", email: "client@example.com", email_verified: true, exp: 2_000_000_000 },
      { iss: configuration.issuer, aud: "staff-aud", type: "app", sub: "access-subject", email: "client@example.com", email_verified: true, exp: 2_000_000_000 },
      { iss: configuration.issuer, aud: configuration.audience, type: "app", sub: "", email: "client@example.com", email_verified: true, exp: 2_000_000_000 },
    ]) expect(verifiedClientPrincipalFromAccessPayload(payload, configuration)).toBeNull();
  });

  it("declares the group-management token as an internal-only secret", () => {
    expect(clientAccessSyncSecretManifest).toEqual(["CLIENT_ACCESS_GROUP_API_TOKEN"]);
  });
});

describe("Client Portal Access sync seam", () => {
  const command: ClientAccessSyncCommand = {
    id: "outbox-1", accountId: "account-1", email: "client@example.com", action: "provision", attempt: 1, idempotencyKey: "client-access-v1:outbox-1",
  };

  it("batches durable commands with an idempotency key and retries a transport outage", async () => {
    let completed: unknown;
    const outbox: ClientAccessSyncOutbox = {
      claim: async () => [command],
      complete: async (_env, commands, results) => { completed = { commands, results }; },
    };
    const processed = await processClientAccessSyncBatch({} as Env, { dispatch: async () => { throw new Error("network"); } }, outbox);
    expect(processed).toBe(1);
    expect(completed).toEqual({ commands: [command], results: [{ id: "outbox-1", outcome: "retry", errorCode: "temporary" }] });
  });

  it("does not dispatch when no client membership work is pending", async () => {
    let dispatched = false;
    const outbox: ClientAccessSyncOutbox = { claim: async () => [], complete: async () => undefined };
    expect(await processClientAccessSyncBatch({} as Env, { dispatch: async () => { dispatched = true; return []; } }, outbox)).toBe(0);
    expect(dispatched).toBe(false);
  });
});
