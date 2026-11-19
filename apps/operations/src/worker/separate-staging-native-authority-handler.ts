import { exactSeparateNativeStagingDeployment, separateNativeOwnerRoute,
  separateNativeRecipientOwnerEnabled, separateNativeWorkspaceOwnerEnabled,
  type SeparateNativeStagingEnv } from "./separate-staging-native-authority-policy";

/** Injectable only to test routing; production supplies the existing authenticated handlers. */
export function createSeparateNativeStagingHandler<E extends SeparateNativeStagingEnv, C>(handlers: {
  ordinary(request: Request, env: E, context: C): Promise<Response>;
  recipient(request: Request, env: E, context: C): Promise<Response>;
  workspace(request: Request, env: E, context: C): Promise<Response>;
}) {
  return async (request: Request, env: E, context: C): Promise<Response> => {
    const absent = () => Response.json({ error: "Not found" }, { status: 404 });
    if (!exactSeparateNativeStagingDeployment(request, env)) return absent();
    const route = separateNativeOwnerRoute(new URL(request.url).pathname);
    if (route === "excluded") return absent();
    if (route === "recipient") {
      if (!separateNativeRecipientOwnerEnabled(env)) return absent();
      return handlers.recipient(request, env, context);
    }
    if (route === "workspace") {
      if (!separateNativeWorkspaceOwnerEnabled(env)) return absent();
      return handlers.workspace(request, env, context);
    }
    return handlers.ordinary(request, env, context);
  };
}
