import { WorkerEntrypoint } from "cloudflare:workers";
import { applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus }
  from "./operations-portal-native-delivery-authority";
import type { Env } from "./types";

/** Private named RPC entrypoint, never a public HTTP grant endpoint. */
export class OperationsPortalNativeDeliveryAuthorityIngress extends WorkerEntrypoint<Env> {
  applyNativeDeliveryAuthority(input: unknown): Promise<string> {
    return applyOperationsPortalNativeDeliveryAuthority(this.env, input);
  }

  getNativeDeliveryAuthorityStatus(input: unknown): Promise<string> {
    return readOperationsPortalNativeDeliveryAuthorityStatus(this.env, input);
  }
}
