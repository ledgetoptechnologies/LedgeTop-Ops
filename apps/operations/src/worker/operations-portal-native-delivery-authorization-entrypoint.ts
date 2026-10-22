import { WorkerEntrypoint } from "cloudflare:workers";
import type { OperationsPortalNativeDeliveryAuthorizationReadRequest,
  OperationsPortalNativeDeliveryAuthorizationReaderBinding, OperationsPortalNativeDeliverySuccessorReaderBinding, OperationsPortalNativeCatalogSuccessorReaderBinding,
  WindowsPortalCatalogFeature }
  from "@ltds/shared/operations-portal-native-delivery-authority";
import { readOperationsPortalNativeDeliveryAuthorizationEntrypoint,
  readWindowsPortalSuccessorAuthorizationEntrypoint, readWindowsPortalCatalogSuccessorAuthorizationEntrypoint,
  type OperationsPortalNativeDeliveryAuthorizationReaderEnv }
  from "./operations-portal-native-delivery-authority-reader";
import type { Env } from "./types";

/** Named private service-binding entrypoint. It is never mounted as HTTP and
 * returns only a primitive JSON string so no RPC disposal metadata crosses the
 * Worker boundary. Root owns its index/config/type registration. */
export class OperationsPortalNativeDeliveryAuthorizationReader extends WorkerEntrypoint<Env>
  implements OperationsPortalNativeDeliveryAuthorizationReaderBinding, OperationsPortalNativeDeliverySuccessorReaderBinding,
    OperationsPortalNativeCatalogSuccessorReaderBinding {
  readNativeDeliveryAuthorization(input: OperationsPortalNativeDeliveryAuthorizationReadRequest): Promise<string> {
    return readOperationsPortalNativeDeliveryAuthorizationEntrypoint(
      this.env as Env & OperationsPortalNativeDeliveryAuthorizationReaderEnv,
      input,
    );
  }
  readWindowsCatalogSuccessorAuthorization(canonicalOriginalGrant: string, feature: WindowsPortalCatalogFeature): Promise<string> {
    return readWindowsPortalCatalogSuccessorAuthorizationEntrypoint(this.env, canonicalOriginalGrant, feature);
  }
  readWindowsDeliverySuccessorAuthorization(canonicalOriginalGrant: string): Promise<string> {
    return readWindowsPortalSuccessorAuthorizationEntrypoint(this.env, canonicalOriginalGrant);
  }
}
