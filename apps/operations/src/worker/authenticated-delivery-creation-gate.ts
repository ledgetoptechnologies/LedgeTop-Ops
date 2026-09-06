import { HTTPException } from "hono/http-exception";

type AuthenticatedDeliveryCreationEnv = {
  AUTHENTICATED_DELIVERY_CREATION_ENABLED?: string;
};

/** Independent incident-response switch for authority-expanding writes. */
export function authenticatedDeliveryCreationEnabled(env: AuthenticatedDeliveryCreationEnv): boolean {
  return env.AUTHENTICATED_DELIVERY_CREATION_ENABLED === "true";
}

export function requireAuthenticatedDeliveryCreation(env: AuthenticatedDeliveryCreationEnv): void {
  if (!authenticatedDeliveryCreationEnabled(env)) {
    throw new HTTPException(503, { message: "New Client Workspace access is temporarily paused" });
  }
}
