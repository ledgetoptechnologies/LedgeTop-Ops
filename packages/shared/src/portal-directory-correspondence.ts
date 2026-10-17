/** Administrative metadata only; browser selectors never supply producer identities. */
export interface PortalDirectoryCorrespondenceProof {
  directorySourceId: string; portalSourceId: 'project-alpha:primary';
  sourceInstanceId: string; applicationId: string; historyEpochId: string;
  baseUrl: string; producerBindingId: string; applicationKey: string;
  connectorRevision: number; connectorVersion: number; currentKeyFingerprint: string;
  primaryAuthorityVersion: number;
}
export interface PortalDirectoryCorrespondenceStatus {
  status: 'not_required' | 'ready' | 'unavailable' | 'suspended';
  reason?: 'schema' | 'configuration' | 'producer' | 'authority' | 'changed';
  current: null | { version: number; state: 'active' | 'revoked'; revisionId: string;
    revocationProofSha256: string; approvedByStaffId:string; approvedAt:string };
  preview: null | { proof: PortalDirectoryCorrespondenceProof; proofSha256: string };
}
export interface PortalDirectoryCorrespondenceCommand {
  operationId: string; action: 'approve' | 'revoke'; expectedVersion: number; expectedProofSha256: string;
}

/** Existing connectors GET includes this discovery. sourceId on a connector remains physical.
 * candidates' IDs are logical selectors, not labels. Historical candidates may be revoke-only.
 * Unique origin eligibility nominates a preview; it never supplies authority without approval.
 */
export interface PortalDirectoryCorrespondenceDiscovery {
 status:'not_required'|'review'|'unavailable';
 candidates:ReadonlyArray<{directorySourceId:string;review:PortalDirectoryCorrespondenceStatus}>;
}

export type PortalDirectoryCorrespondenceResult =
 | {ok:true;operationId:string;action:'approve'|'revoke';directorySourceId:string;requestSha256:string;version:number;revisionId:string;replayed:boolean}
 | {ok:false;code:'rejected'|'outcome_unknown';operationId:string};
