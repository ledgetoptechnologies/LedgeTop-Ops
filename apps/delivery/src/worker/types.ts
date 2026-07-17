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
  PUBLIC_BASE_URL: string;
  EXPECTED_HOST: string;
  ENVIRONMENT: string;
  SESSION_KEY_ID: string;
  DELIVERY_SESSION_SECRET: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  AUDIT_IP_SECRET: string;
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
}
