export const STAGING_ACCOUNT_ID = "846c924bf17bf4f3dd15c97a4c5d1d51";

export const REQUIRED_STAGING_SECRETS = Object.freeze({
  delivery: Object.freeze(["DELIVERY_SESSION_SECRET", "DELIVERY_ACCESS_CODE_PEPPER", "AUDIT_IP_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]),
  operations: Object.freeze(["OPERATIONS_SESSION_SECRET", "DELIVERY_TOKEN_SECRET", "DELIVERY_ACCESS_CODE_PEPPER", "AUDIT_IP_SECRET", "PROJECT_ALPHA_API_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]),
  "ops-sync": Object.freeze(["CF_ACCESS_GROUP_API_TOKEN", "PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY"]),
});

export const STAGING_HOSTS = Object.freeze({
  delivery: "delivery-staging.ledgetopdroneservices.com",
  operations: "ops-staging.ledgetopdroneservices.com",
  incoming: "incoming-staging.ledgetopdroneservices.com",
  "ops-sync": "ops-sync-staging.ledgetopdroneservices.com",
});

export const STAGING_ACCESS_AUDS = Object.freeze({
  delivery: "f6942c97e306d81d206c94746dc731413d5e59461b35d9b213f13fdf96b62835",
  operations: "e5e2026896677c6fbaa0c7eb9b795e326516c15a3191dfba3c2ad43da4728671",
  "ops-sync": "7b578ad388abb5c5eb550e86ddf3263af0b2a5694e8bf4810c67affa5721ec37",
});

export const STAGING_STATIC_VARS = Object.freeze({
  delivery: Object.freeze({
    TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    R2_S3_ENDPOINT: "https://846c924bf17bf4f3dd15c97a4c5d1d51.r2.cloudflarestorage.com",
    R2_BUCKET_NAME: "client-data-staging",
  }),
  operations: Object.freeze({
    TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    DELIVERY_BASE_URL: "https://delivery-staging.ledgetopdroneservices.com",
    R2_ACCOUNT_ID: STAGING_ACCOUNT_ID,
    R2_BUCKET_NAME: "client-data-staging",
    R2_INCOMING_BUCKET_NAME: "ltds-incoming-staging",
    APPLICATION_KEY: "ltds_ops_staging",
  }),
  "ops-sync": Object.freeze({
    TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    CF_ACCOUNT_ID: STAGING_ACCOUNT_ID,
    APPLICATION_KEY: "ltds_ops_staging",
  }),
});

export const STAGING_INVENTORY = Object.freeze({
  delivery: {
    name: "ltds-delivery-staging",
    routes: [{ pattern: STAGING_HOSTS.delivery, custom_domain: true }],
    d1_databases: [{ binding: "DELIVERY_DB", database_name: "client-data-staging", database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "DATA_BUCKET", bucket_name: "client-data-staging" }],
    workflows: [
      { name: "ltds-bulk-download-staging", binding: "BULK_DOWNLOAD_WORKFLOW", class_name: "BulkDownloadWorkflow" },
      { name: "ltds-cloud-transfer-staging", binding: "CLOUD_TRANSFER_WORKFLOW", class_name: "CloudTransferWorkflow" },
    ],
    queues: [],
    ratelimits: [
      { name: "ACCESS_CODE_RATE_LIMITER", namespace_id: "730202601", simple: { limit: 10, period: 60 } },
      { name: "PUBLIC_SESSION_RATE_LIMITER", namespace_id: "730202602", simple: { limit: 20, period: 60 } },
      { name: "PUBLIC_MANIFEST_RATE_LIMITER", namespace_id: "730202603", simple: { limit: 120, period: 60 } },
      { name: "PUBLIC_MEDIA_RATE_LIMITER", namespace_id: "730202604", simple: { limit: 180, period: 60 } },
      { name: "PUBLIC_BULK_RATE_LIMITER", namespace_id: "730202605", simple: { limit: 3, period: 60 } },
      { name: "PUBLIC_THUMBNAIL_RATE_LIMITER", namespace_id: "730202606", simple: { limit: 300, period: 60 } },
      { name: "PUBLIC_DOWNLOAD_RATE_LIMITER", namespace_id: "730202607", simple: { limit: 30, period: 60 } },
      { name: "PUBLIC_STREAM_RATE_LIMITER", namespace_id: "730202608", simple: { limit: 10, period: 60 } },
    ],
  },
  operations: {
    name: "ltds-ops-staging",
    routes: [{ pattern: STAGING_HOSTS.operations, custom_domain: true }],
    d1_databases: [
      { binding: "OPS_DB", database_name: "ltds-ops-staging", database_id: "78b34173-b168-4e3d-9832-bb9d245cc6b8", migrations_dir: "migrations" },
      { binding: "DELIVERY_DB", database_name: "client-data-staging", database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb", migrations_dir: "../delivery/migrations" },
    ],
    r2_buckets: [
      { binding: "DATA_BUCKET", bucket_name: "client-data-staging" },
      { binding: "INCOMING_BUCKET", bucket_name: "ltds-incoming-staging" },
    ],
    workflows: [
      { name: "ltds-r2-crud-staging", binding: "R2_CRUD_WORKFLOW", class_name: "R2CrudWorkflow" },
      { name: "ltds-incoming-upload-lifecycle-staging", binding: "INCOMING_LIFECYCLE_WORKFLOW", class_name: "IncomingUploadLifecycleWorkflow" },
      { name: "ltds-dropbox-import-staging", binding: "DROPBOX_IMPORT_WORKFLOW", class_name: "DropboxImportWorkflow" },
    ],
    queues: [{ queue: "ltds-file-events-staging", max_batch_size: 25, max_batch_timeout: 10, max_retries: 5, dead_letter_queue: "ltds-file-events-staging-dlq" }],
    ratelimits: [],
  },
  "ops-sync": {
    name: "ltds-ops-sync-staging",
    routes: [{ pattern: STAGING_HOSTS["ops-sync"], custom_domain: true }],
    d1_databases: [{ binding: "OPS_DB", database_name: "ltds-ops-staging", database_id: "78b34173-b168-4e3d-9832-bb9d245cc6b8", migrations_dir: "../operations/migrations" }],
    r2_buckets: [],
    workflows: [],
    queues: [],
    ratelimits: [],
  },
});
