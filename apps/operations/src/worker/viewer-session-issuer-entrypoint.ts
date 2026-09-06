import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ClientViewerSessionRequestV1,
  ClientViewerSessionResultV1,
  NativeClientViewerAuthorizationV1,
  NativeClientViewerModelsResultV1,
  NativeClientViewerSessionRequestV1,
  ClientViewerShareCreateRequestV1,
  ClientViewerShareCreateResultV1,
  ClientViewerShareListRequestV1,
  ClientViewerShareListResultV1,
  ClientViewerShareRevokeRequestV1,
  ClientViewerShareRevokeResultV1,
} from "@ltds/shared";
import type { Env } from "./types";
import {
  createClientViewerShare,
  issueNativeClientViewerSession,
  listNativeClientViewerModels,
  issueClientViewerSession,
  listClientViewerShares,
  revokeClientViewerShare,
} from "./viewer-session-issuer";

export class ViewerSessionIssuer extends WorkerEntrypoint<Env> {
  listNativeClientViewerModels(request: NativeClientViewerAuthorizationV1): Promise<NativeClientViewerModelsResultV1> {
    return listNativeClientViewerModels(this.env, request);
  }
  issueNativeClientViewerSession(request: NativeClientViewerSessionRequestV1): Promise<ClientViewerSessionResultV1> {
    return issueNativeClientViewerSession(this.env, request);
  }
  issueClientViewerSession(request: ClientViewerSessionRequestV1): Promise<ClientViewerSessionResultV1> {
    return issueClientViewerSession(this.env, request);
  }
  createClientViewerShare(request: ClientViewerShareCreateRequestV1): Promise<ClientViewerShareCreateResultV1> {
    return createClientViewerShare(this.env, request);
  }
  listClientViewerShares(request: ClientViewerShareListRequestV1): Promise<ClientViewerShareListResultV1> {
    return listClientViewerShares(this.env, request);
  }
  revokeClientViewerShare(request: ClientViewerShareRevokeRequestV1): Promise<ClientViewerShareRevokeResultV1> {
    return revokeClientViewerShare(this.env, request);
  }
}
