import type { Env } from "../types";

export type CloudProvider = "dropbox" | "google";
export type ConflictMode = "autorename" | "skip";
export type CloudJobStatus =
  | "queued" | "running" | "cancelling" | "completed" | "partial"
  | "failed" | "cancelled" | "expired";
export type CloudItemStatus =
  | "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled" | "skipped";

export interface CloudTransferEnv extends Env {
  CLOUD_TRANSFER_TOKEN_SECRET: string;
  CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET?: string;
  CLOUD_TRANSFER_KEY_ID?: string;
  CLOUD_TRANSFER_PREVIOUS_KEY_ID?: string;
}

export interface CloudTransferJob {
  id: string;
  share_id: string;
  share_version: number;
  authorization_id: string;
  provider: CloudProvider;
  selection_json: string;
  destination_json: string;
  conflict_mode: ConflictMode;
  status: CloudJobStatus;
  file_count: number;
  processed_files: number;
  succeeded_files: number;
  failed_files: number;
  total_bytes: number;
  processed_bytes: number;
  cancel_requested_at: string | null;
  error_code: string | null;
  error_message: string | null;
  expires_at: string;
}

export interface CloudTransferItem {
  id: string;
  job_id: string;
  ordinal: number;
  source_key: string;
  relative_path: string;
  source_etag: string;
  source_size: number;
  destination_path: string;
  status: CloudItemStatus;
  attempts: number;
  uploaded_bytes: number;
  provider_file_id: string | null;
  provider_job_id: string | null;
  upload_state_ciphertext: string | null;
  upload_state_iv: string | null;
  source_grant_hash: string | null;
  source_grant_ciphertext: string | null;
  source_grant_iv: string | null;
  source_grant_expires_at: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_at: string | null;
}

export interface CloudCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface TransferSource {
  physicalKey: string;
  relativePath: string;
  destinationPath: string;
  size: number;
  etag: string;
}

export interface CloudProviderTransferResult {
  status: "completed" | "skipped";
  providerFileId?: string;
  providerJobId?: string;
  uploadedBytes: number;
}

export interface CloudProviderAdapter {
  transfer(input: {
    env: CloudTransferEnv;
    job: CloudTransferJob;
    item: CloudTransferItem;
    credential: CloudCredential;
    destination: unknown;
    conflictMode: ConflictMode;
    signalCancelled: () => Promise<boolean>;
    saveUploadState: (state: unknown, uploadedBytes: number) => Promise<void>;
  }): Promise<CloudProviderTransferResult>;
  revoke?(credential: CloudCredential): Promise<void>;
}
