import { reserveOperationsPortalWorkspacePublication, dispatchOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationBinding } from "../../src/worker/operations-portal-workspace-publication-outbox";
import { cancelOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationCancellationBinding }
  from "../../src/worker/operations-portal-workspace-publication-cancellations";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../../src/worker/native-staff-auth";

type ClientBinding = OperationsPortalWorkspacePublicationBinding & OperationsPortalWorkspacePublicationCancellationBinding
  & { fetch(request: Request): Promise<Response> };
type DriverEnv = { OPS_DB: D1Database; CLIENT_PUBLICATION: ClientBinding };
type DriverInput = { actor: AuthenticatedNativeStaffWithAdmissionVersion; reservation: Parameters<typeof reserveOperationsPortalWorkspacePublication>[2] };

const json = (value: unknown, status = 200) => Response.json(value, { status });
async function note(db: D1Database, kind: string) {
  await db.prepare(`INSERT INTO rpc_publication_test_calls(kind,count) VALUES(?,1)
    ON CONFLICT(kind) DO UPDATE SET count=count+1`).bind(kind).run();
}

export default {
  async fetch(request: Request, env: DriverEnv): Promise<Response> {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (request.method !== "POST" || !Number.isSafeInteger(declaredLength)
      || declaredLength < 0 || declaredLength > 20_000) {
      return json({ error: "invalid-request" }, 400);
    }
    const action = new URL(request.url).pathname.slice(1);
    if (action === "client-http") return env.CLIENT_PUBLICATION.fetch(request);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 20_000) return json({ error: "invalid-request" }, 413);
    const input: DriverInput | { operationId: string } = JSON.parse(body);
    if (action.startsWith("reserve-")) {
      if (!("actor" in input) || !("reservation" in input)) return json({ error: "invalid-request" }, 400);
      const reserved = await reserveOperationsPortalWorkspacePublication(env.OPS_DB, input.actor, input.reservation);
      const binding: OperationsPortalWorkspacePublicationBinding = action === "reserve-discard-publish"
        ? { async publishWorkspace(publication) {
          await note(env.OPS_DB, "discard-publish:publish");
          await env.CLIENT_PUBLICATION.publishWorkspace(publication);
          throw new Error("caller-discarded-publish-result");
        }, async getPublicationStatus() { throw new Error("status-not-expected-before-first-attempt"); } }
        : action === "reserve-fail-before-publish"
          ? { async publishWorkspace() { throw new Error("ambiguous-before-client-invocation"); },
            async getPublicationStatus() { throw new Error("status-not-expected-before-first-attempt"); } }
          : env.CLIENT_PUBLICATION;
      const dispatched = await dispatchOperationsPortalWorkspacePublication({ db: env.OPS_DB,
        operationId: input.reservation.operationId, binding });
      const outbox = await env.OPS_DB.prepare(`SELECT state,remote_attempted,last_error_code
        FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`)
        .bind(input.reservation.operationId).first();
      return json({ reserved, dispatched, outbox });
    }
    if (!("operationId" in input)) return json({ error: "invalid-request" }, 400);
    if (action === "dispatch") return json(await dispatchOperationsPortalWorkspacePublication({ db: env.OPS_DB,
      operationId: input.operationId, binding: { async publishWorkspace(publication) {
        await note(env.OPS_DB, "recovery:publish"); return env.CLIENT_PUBLICATION.publishWorkspace(publication);
      }, async getPublicationStatus(publication) {
        await note(env.OPS_DB, "recovery:status"); return env.CLIENT_PUBLICATION.getPublicationStatus(publication);
      } } }));
    if (action === "cancel-discard") {
      const binding: OperationsPortalWorkspacePublicationCancellationBinding = {
        async getPublicationDisposition(publication) { await note(env.OPS_DB, "cancel:disposition");
          return env.CLIENT_PUBLICATION.getPublicationDisposition(publication); },
        async cancelWorkspacePublication(publication) {
          await note(env.OPS_DB, "cancel:cancel");
          await env.CLIENT_PUBLICATION.cancelWorkspacePublication(publication);
          throw new Error("caller-discarded-cancellation-result");
        },
      };
      return json(await cancelOperationsPortalWorkspacePublication({ db: env.OPS_DB,
        operationId: input.operationId, binding }));
    }
    if (action === "cancel") {
      const binding: OperationsPortalWorkspacePublicationCancellationBinding = {
        async getPublicationDisposition(publication) { await note(env.OPS_DB, "cancel-recovery:disposition");
          return env.CLIENT_PUBLICATION.getPublicationDisposition(publication); },
        async cancelWorkspacePublication(publication) { await note(env.OPS_DB, "cancel-recovery:cancel");
          return env.CLIENT_PUBLICATION.cancelWorkspacePublication(publication); },
      };
      const result = await cancelOperationsPortalWorkspacePublication({ db: env.OPS_DB,
        operationId: input.operationId, binding });
      const outbox = await env.OPS_DB.prepare(`SELECT state,remote_attempted,last_error_code
        FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`).bind(input.operationId).first();
      return json({ result, outbox });
    }
    if (action === "race") {
      const [dispatch, cancellation] = await Promise.allSettled([
        dispatchOperationsPortalWorkspacePublication({ db: env.OPS_DB, operationId: input.operationId,
          binding: env.CLIENT_PUBLICATION }),
        cancelOperationsPortalWorkspacePublication({ db: env.OPS_DB, operationId: input.operationId,
          binding: env.CLIENT_PUBLICATION }),
      ]);
      const rejected = (value: PromiseRejectedResult) => ({ error:
        value.reason instanceof Error ? value.reason.message : "rejected" });
      return json({ dispatch: dispatch.status === "fulfilled" ? dispatch.value : rejected(dispatch),
        cancellation: cancellation.status === "fulfilled" ? cancellation.value : rejected(cancellation) });
    }
    return json({ error: "not-found" }, 404);
  },
};
