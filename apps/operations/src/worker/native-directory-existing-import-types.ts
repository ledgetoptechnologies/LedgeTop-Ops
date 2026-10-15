import type { NativeDirectoryCreateWrite } from "./native-directory-profile-writer";
import type { ProjectAlphaDirectoryProfileObservation } from "./project-alpha-directory-read-api-v2";
import type { Env } from "./types";

export type NativeExistingImportActor = Readonly<{
  staffId: string; accessSubject: string; loginEmail: string; admissionVersion: number;
  profileVersion: number; grantGeneration: number; verifiedUntil: string;
}>;
export type NativeExistingImportEnvironment = Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS"> & Readonly<{
  NATIVE_DIRECTORY_EXISTING_IMPORT_ENABLED?: string;
  NATIVE_DIRECTORY_EXISTING_IMPORT_AREAS?: string;
}>;
export type NativeExistingImportSelection = Readonly<{
  batchId: string; sourceId: string; kind: "organization" | "client"; recordId: string; businessAreaId: string; idempotencyKey: string;
}>;
export type NativeExistingImportReview = Readonly<{
  importId: string; batchId: string; idempotencyKey: string; sourceId: string; sourceInstanceId: string;
  applicationId: string; historyEpoch: string; origin: string; kind: "organization" | "client";
  recordId: string; nativeRecordId: string; publicId: string; classicPayload: string; classicName: string;
  parentRecordId: string | null; parentNativeRecordId: string | null; parentPublicId: string | null; businessAreaId: string;
  profile: NativeDirectoryCreateWrite["profile"]; observation: ProjectAlphaDirectoryProfileObservation;
  actor: NativeExistingImportActor;
  selectedGrants: ReadonlyArray<Readonly<{ permission: string; id: string }>>;
  reviewedAt: string; expiresAt: string;
}>;
export type NativeExistingImportOutcome =
  | Readonly<{ status: "reviewed"; review: NativeExistingImportReview; replayed: boolean }>
  | Readonly<{ status: "activated"; importId: string; recordId: string; activationId: string; replayed: boolean }>
  | Readonly<{ status: "pending"; importId: string; reason: string }>
  | Readonly<{ status: "blocked" | "conflict"; reason: string; importId?: string }>;
