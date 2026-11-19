import standardWorker from "./index";
import { handleOperationsNativeRecipientOwnerHttp } from "./operations-portal-native-recipient-owner-http";
import { dispatchOperationsPortalNativeOwnerRequest, type OperationsPortalNativeOwnerEnv }
  from "./operations-portal-native-owner-routes";
import { createSeparateNativeStagingHandler } from "./separate-staging-native-authority-handler";
import { SEPARATE_NATIVE_STAGE, type SeparateNativeStagingEnv } from "./separate-staging-native-authority-policy";

type StageEnv = OperationsPortalNativeOwnerEnv & SeparateNativeStagingEnv;
const fetch = createSeparateNativeStagingHandler<StageEnv, ExecutionContext>({
  ordinary: async (request, env, context) => await standardWorker.fetch(request, env, context),
  recipient: async (request, env) => {
    if (new URL(request.url).pathname === "/administration/client-portal/operations-recipients") {
      return await dispatchOperationsPortalNativeOwnerRequest(request, env)
        ?? Response.json({ error: "Not found" }, { status: 404 });
    }
    return handleOperationsNativeRecipientOwnerHttp(request, {
      environment: env.ENVIRONMENT, expectedHost: SEPARATE_NATIVE_STAGE.host,
      configuration: { enabled: true, issuer: SEPARATE_NATIVE_STAGE.issuer,
        staffAudience: SEPARATE_NATIVE_STAGE.audience, origin: SEPARATE_NATIVE_STAGE.origin,
        recipientOrigin: SEPARATE_NATIVE_STAGE.recipientOrigin, csrfSecret: env.OPERATIONS_SESSION_SECRET },
      database: env.OPS_DB, dispatch: env,
    });
  },
  workspace: async (request, env) => await dispatchOperationsPortalNativeOwnerRequest(request, env)
    ?? Response.json({ error: "Not found" }, { status: 404 }),
});

export default { fetch, queue: standardWorker.queue, scheduled: standardWorker.scheduled };
// Includes OperationsNativePrincipalInquiryIngress; no new public RPC route.
export * from "./index";
