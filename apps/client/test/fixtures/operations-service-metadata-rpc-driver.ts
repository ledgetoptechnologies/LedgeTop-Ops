import { readOperationsServiceHome } from "../../src/worker/client-portal/operations-service-home";
import type { OperationsServiceHomeEnv } from "../../src/worker/client-portal/operations-service-home";

export default {
  async fetch(request: Request, env: OperationsServiceHomeEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/raw") {
      const value = await env.CLIENT_PORTAL_SERVICE_METADATA_READER!.readServiceMetadata({ protocolVersion: 1,
        authorityId: "11111111-1111-4111-8111-111111111111", workspaceId: "workspace-one",
        ownershipEpoch: 1, grantRevision: 1, issuer: "https://access.example.test", subject: "person-one" });
      return Response.json({ type: typeof value, symbols: Object.getOwnPropertySymbols(value).map(String), parsed: JSON.parse(value) });
    }
    const result = await readOperationsServiceHome(env, {
      issuer: "https://access.example.test", subject: "person-one",
    }, "11111111-1111-4111-8111-111111111111");
    return Response.json(result);
  },
};
