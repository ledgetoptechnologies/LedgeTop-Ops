export interface ImagesBindingLike {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): { output(options: Record<string, unknown>): Promise<{ response(): Response }> };
  };
}

export interface Env {
  DELIVERY_DB: D1Database;
  DATA_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  IMAGES: ImagesBindingLike;
  STREAM: { video(id: string): { generateToken(): Promise<string> } };
  ACCESS_CODE_RATE_LIMITER: RateLimit;
  PUBLIC_SESSION_RATE_LIMITER: RateLimit;
  PUBLIC_MANIFEST_RATE_LIMITER: RateLimit;
  PUBLIC_MEDIA_RATE_LIMITER: RateLimit;
  PUBLIC_THUMBNAIL_RATE_LIMITER: RateLimit;
  PUBLIC_DOWNLOAD_RATE_LIMITER: RateLimit;
  PUBLIC_STREAM_RATE_LIMITER: RateLimit;
  PUBLIC_BULK_RATE_LIMITER: RateLimit;
  PUBLIC_BASE_URL: string;
  EXPECTED_HOST: string;
  ENVIRONMENT: string;
  SESSION_KEY_ID: string;
  PREVIOUS_SESSION_KEY_ID?: string;
  DELIVERY_SESSION_SECRET: string;
  DELIVERY_PREVIOUS_SESSION_SECRET?: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER?: string;
  AUDIT_IP_SECRET: string;
  R2_S3_ENDPOINT: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  BULK_DOWNLOAD_WORKFLOW: Workflow;
  CLOUD_TRANSFER_WORKFLOW: Workflow;
  CLOUD_TRANSFER_DROPBOX_ENABLED?: string;
  CLOUD_TRANSFER_GOOGLE_ENABLED?: string;
  CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED?: string;
  DROPBOX_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_CLOUD_PROJECT_NUMBER?: string;
  CLOUD_TRANSFER_TOKEN_SECRET?: string;
  CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET?: string;
  CLOUD_TRANSFER_KEY_ID?: string;
  CLOUD_TRANSFER_PREVIOUS_KEY_ID?: string;
  STREAM_CUSTOMER_CODE?: string;
}

export interface ShareRow {
  id: string;
  public_id: string | null;
  project_id: string;
  token_hash: string;
  label: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  password_algorithm: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  unavailable_since: string | null;
  share_version: number;
  client_name: string;
  project_name: string;
  r2_prefix: string;
  recipient_email?: string | null;
}
