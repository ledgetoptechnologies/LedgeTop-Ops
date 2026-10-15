import { WorkerEntrypoint } from "cloudflare:workers";
import { applyOperationsPortalNativeDeliveryAuthority, cancelOperationsPortalNativeDeliveryAuthority,
  readOperationsPortalNativeDeliveryAuthorityDisposition, readOperationsPortalNativeDeliveryAuthorityStatus }
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

  getNativeDeliveryAuthorityDisposition(input: unknown): Promise<string> {
    return readOperationsPortalNativeDeliveryAuthorityDisposition(this.env, input);
  }

  cancelNativeDeliveryAuthority(input: unknown): Promise<string> {
    return cancelOperationsPortalNativeDeliveryAuthority(this.env, input);
  }
}
