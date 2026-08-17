import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ClientViewerSessionRequestV1,
  ClientViewerSessionResultV1,
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
  issueClientViewerSession,
  listClientViewerShares,
  revokeClientViewerShare,
} from "./viewer-session-issuer";

export class ViewerSessionIssuer extends WorkerEntrypoint<Env> {
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
