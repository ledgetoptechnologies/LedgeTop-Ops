export interface ClientPortalServiceMetadataRequestV1 {
  protocolVersion: 1;
  authorityId: string;
  workspaceId: string;
  ownershipEpoch: number;
  grantRevision: number;
  issuer: string;
  subject: string;
}

export interface ClientPortalServiceMetadataV1 {
  serviceId: string;
  providerId: string;
  displayLabel: string;
  revision: number;
}

export type ClientPortalServiceMetadataResultV1 =
  | Readonly<{ ok: true; protocolVersion: 1; services: readonly ClientPortalServiceMetadataV1[] }>
  | Readonly<{ ok: false; protocolVersion: 1; code: "invalid_request" | "denied" | "overflow" }>;
