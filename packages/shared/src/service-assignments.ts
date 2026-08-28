export const SERVICE_ASSIGNMENT_PROJECTION_SCHEMA_VERSION = 1 as const;

export const SERVICE_ASSIGNMENT_SUBJECT_TYPES = [
  "organization",
  "standalone_client",
  "department",
  "client",
  "project",
] as const;

export type ServiceAssignmentSubjectType = typeof SERVICE_ASSIGNMENT_SUBJECT_TYPES[number];

/** A source-owned fact. It is not a portal, file, billing, or membership grant. */
export interface ServiceAssignmentProjectionItemV1 {
  assignmentPublicId: string;
  sourceVersion: string;
  subjectType: ServiceAssignmentSubjectType;
  subjectPublicId: string;
  servicePublicId: string;
  serviceSourceVersion: string;
  active: boolean;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}

export interface ServiceAssignmentProjectionCommonV1 {
  schemaVersion: typeof SERVICE_ASSIGNMENT_PROJECTION_SCHEMA_VERSION;
  applicationKey: string;
  deliveryId: string;
  occurredAt: string;
  sourceGeneration: string;
  sourceSequence: number;
}

export interface ServiceAssignmentSnapshotPageV1 extends ServiceAssignmentProjectionCommonV1 {
  kind: "snapshot.page";
  snapshotHash: string;
  pageNumber: number;
  pageCount: number;
  itemCount: number;
  items: ServiceAssignmentProjectionItemV1[];
}

export interface ServiceAssignmentSnapshotActivateV1 extends ServiceAssignmentProjectionCommonV1 {
  kind: "snapshot.activate";
  snapshotHash: string;
  pageCount: number;
  itemCount: number;
}

export interface ServiceAssignmentEventV1 extends ServiceAssignmentProjectionCommonV1 {
  kind: "event";
  event:
    | { action: "upsert"; item: ServiceAssignmentProjectionItemV1 }
    | { action: "tombstone"; assignmentPublicId: string; sourceVersion: string };
}

export type ServiceAssignmentProjectionDeliveryV1 =
  | ServiceAssignmentSnapshotPageV1
  | ServiceAssignmentSnapshotActivateV1
  | ServiceAssignmentEventV1;
