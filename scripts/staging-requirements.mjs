export const STAGING_ACCOUNT_ID = "846c924bf17bf4f3dd15c97a4c5d1d51";
export const STAGING_PROJECT_ALPHA_ORIGIN = "https://project-alpha-staging.ledgetopdroneservices.com";

// Runtime candidates are pinned independently from the release-packet HEAD.
// This lets evidence and documentation evolve without silently changing the
// exact application bytes approved for staging. Set this back to false whenever
// any candidate changes, then refresh every immutable commit/image/migration pin.
// A false value permits an explicit PENDING_VIEWER_IMAGE_FOR_<commit> sentinel
// while a replacement image is publishing. Set this to true only after final
// commits, the image digest, fixtures, and migration checksums pass the
// independent cross-repository gate; reset it before changing any pin.
export const RELEASE_CONTRACT_FINALIZED = false;
export const RELEASE_CANDIDATES = Object.freeze({
  operations: "5c35268722289730dfdfe5b908593b50c0510ee9",
  viewer: "dd5055c8563a5b67ecb1dce7cd4046ce8f833f7e",
  projectAlpha: "e3355875d86250628ad630c1d02baa1ecc127a77",
});

export const STAGING_VIEWER = Object.freeze({
  hostname: "viewer-staging.ledgetopdroneservices.com",
  origin: "https://viewer-staging.ledgetopdroneservices.com",
  image: "PENDING_VIEWER_IMAGE_FOR_dd5055c8563a5b67ecb1dce7cd4046ce8f833f7e",
  schemaVersion: 21,
  serviceKeyId: "ops-staging-v1",
  eventKeyId: "viewer-staging-v1",
  providerCredentialsKeyId: "provider-staging-v1",
  requiredSecretNames: Object.freeze([
    "SESSION_SECRET", "SERVICE_AUTH_SECRET", "VIEWER_EVENT_SECRET",
    "PROVIDER_CREDENTIALS_KEY",
  ]),
});

export const PROJECT_ALPHA_STAGING = Object.freeze({
  releaseCommit: RELEASE_CANDIDATES.projectAlpha,
  migrations: Object.freeze({
    "0066_generic_portal_v2_integration.sql": "12cfd32e4854bddf763a5fe80653fe7494ab5f9e82b592bf0da05eed78f3e886",
    "0067_portal_projection_delivery.sql": "a8150facbd25ff8c3275a591b09c2e75a50302abdc9c212477e3cc36d0cf11ea",
    "0068_portal_contract_completeness.sql": "6d35f540edd176d192503d69d2d9c8914cd3e40f3f9d5f0e522eeef96ffdab37",
    "0069_managed_delivery_intents.sql": "76369a571d771bf28b3778f61bccf536827457538ba04244a0135ab7672c6364",
  }),
  defaultOffSettings: Object.freeze([
    "portal_v2_integration_enabled", "portal_v2_relations_enabled",
    "portal_catalog_v2_enabled", "portal_pricing_preview_enabled",
    "portal_draft_quotes_enabled", "portal_outbound_delivery_enabled",
    "portal_authoritative_hooks_enabled",
    "managed_delivery_enabled", "managed_delivery_intent_url",
    "managed_delivery_profile_id", "managed_delivery_guest_links_enabled",
  ]),
  outboundSchedule: "* * * * *",
});

// Logical service identities remain stable even when their source directories
// change. "delivery" still names the deployed Worker and staging evidence;
// only its repository directory is apps/client.
export const APP_SOURCE_DIRS = Object.freeze({
  delivery: "client",
  operations: "operations",
  "ops-sync": "ops-sync",
});

export const REQUIRED_STAGING_SECRETS = Object.freeze({
  delivery: Object.freeze([
    "DELIVERY_SESSION_SECRET", "DELIVERY_ACCESS_CODE_PEPPER", "AUDIT_IP_SECRET",
    "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
    "PROJECT_ALPHA_CATALOG_HMAC_SECRET", "PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET",
    "PROJECT_ALPHA_PORTAL_HMAC_SECRET", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET",
    "PROJECT_ALPHA_PRICING_HINT_API_KEY", "PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET",
    "CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET",
    "CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID", "CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY",
    "CLIENT_DELEGATED_SHARE_SESSION_SECRET",
  ]),
  operations: Object.freeze([
    "OPERATIONS_SESSION_SECRET", "DELIVERY_TOKEN_SECRET", "DELIVERY_ACCESS_CODE_PEPPER",
    "AUDIT_IP_SECRET", "PROJECT_ALPHA_API_KEY", "PROJECT_ALPHA_DRAFT_QUOTE_API_KEY",
    "PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
    "R2_DELIVERY_UPLOAD_ACCESS_KEY_ID", "R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY",
    "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "INCOMING_SESSION_SECRET",
    "INCOMING_ACCESS_CODE_PEPPER", "INCOMING_PICKUP_SECRET", "THUMBNAIL_INGEST_SECRET",
    "VIEWER_SERVICE_HMAC_SECRET", "VIEWER_EVENT_HMAC_SECRET",
  ]),
  "ops-sync": Object.freeze(["CF_ACCESS_GROUP_API_TOKEN", "PROJECT_ALPHA_WEBHOOK_HMAC_SECRET"]),
});

export const STAGING_HOSTS = Object.freeze({
  delivery: "delivery-staging.ledgetopdroneservices.com",
  client: "client-staging.ledgetopdroneservices.com",
  operations: "ops-staging.ledgetopdroneservices.com",
  incoming: "incoming-staging.ledgetopdroneservices.com",
  "ops-sync": "ops-sync-staging.ledgetopdroneservices.com",
  viewer: STAGING_VIEWER.hostname,
});

export const STAGING_CLIENT_PORTAL = Object.freeze({
  applicationName: "LTDS Client Portal Staging",
  publicApplicationName: "LTDS Client Public Staging",
  hostname: STAGING_HOSTS.client,
  protectedPaths: Object.freeze(["/portal", "/portal/*", "/api/client", "/api/client/*"]),
  publicPaths: Object.freeze(["/", "/s/*", "/client-share/*", "/api/public/*", "/health", "/assets/*"]),
  groupName: "LTDS Client Portal Staging Testers",
});

export const STAGING_REQUEST_ATTACHMENT_R2_CORS = Object.freeze({
  rules: Object.freeze([Object.freeze({
    allowed: Object.freeze({
      origins: Object.freeze([`https://${STAGING_HOSTS.client}`]),
      methods: Object.freeze(["PUT"]),
      headers: Object.freeze(["content-type"]),
    }),
    exposeHeaders: Object.freeze(["etag"]),
    maxAgeSeconds: 300,
  })]),
});

export const REQUIRED_STAGING_MIGRATIONS = Object.freeze({
  delivery: Object.freeze([
    "0096_client_portal_foundation.sql",
    "0097_client_portal_team_acl.sql",
    "0098_client_access_sync_processing.sql",
    "0099_client_portal_request_notifications.sql",
    "0100_client_portal_release_hardening.sql",
    "0101_client_service_request_scoping.sql",
    "0102_client_service_request_area.sql",
    "0103_client_portal_workspace.sql",
    "0104_service_request_thread.sql",
    "0105_internal_folder_grants.sql",
    "0106_image_thumbnail_jobs.sql",
    "0107_thumbnail_cleanup_jobs.sql",
    "0108_thumbnail_backfill_runs.sql",
    "0109_image_asset_locations.sql",
    "0110_thumbnail_backfill_jobs_scope.sql",
    "0111_thumbnail_render_provenance.sql",
    "0112_public_share_location_privacy.sql",
    "0114_delivery_share_prefix_lookup.sql",
    "0115_client_workspace_notifications.sql",
    "0116_incoming_upload_hardening.sql",
    "0117_service_request_v2.sql",
    "0118_staff_work_area_revisions.sql",
    "0119_client_request_attachments.sql",
    "0120_project_alpha_draft_quote_receipts.sql",
    "0121_client_workspace_hierarchy_v2.sql",
    "0122_project_alpha_service_catalog_projection.sql",
    "0123_portal_v2_membership_management.sql",
    "0124_client_delegated_public_shares.sql",
    "0125_project_alpha_portal_projection.sql",
    "0126_delivery_share_recipient_snapshots.sql",
    "0127_portal_invitation_secret_scrub.sql",
    "0128_project_alpha_catalog_compatibility.sql",
    "0129_portal_hierarchy_relations.sql",
    "0130_client_delegated_share_provisioning.sql",
    "0131_video_thumbnail_recovery_backfill.sql",
    "0132_portal_v2_legacy_member_bridges.sql",
    "0133_portal_invitation_access_enrollment_receipts.sql",
    "0134_rejected_request_attachment_submit_guard.sql",
    "0135_security_scan_followups.sql",
    "0136_portal_v2_identity_denials.sql",
    "0137_authenticated_delivery_grants.sql",
    "0138_viewer_model_associations.sql",
    "0139_thumbnail_claim_queue_index.sql",
    "0140_truenas_thumbnail_provenance.sql",
    "0141_viewer_client_preferences.sql",
    "0142_client_viewer_shares.sql",
    "0143_viewer_session_revocation_outbox.sql",
    "0144_viewer_client_grants.sql",
    "0145_portal_identity_eligibility.sql",
    "0146_viewer_client_grant_audit.sql",
    "0147_project_alpha_delivery_intents.sql",
    "0148_single_file_delivery_shares.sql",
  ]),
  operations: Object.freeze([
    "0014_staff_acl_controls.sql",
    "0015_staff_acl_explicit_controls.sql",
    "0016_projection_entity_leases.sql",
    "0017_operational_job_briefs.sql",
    "0018_browser_upload_intents.sql",
    "0019_browser_upload_conflict_resolution.sql",
    "0020_internal_sop_library.sql",
    "0021_project_alpha_sync_hardening.sql",
    "0022_r2_operation_retries.sql",
    "0023_project_task_sop_links.sql",
    "0024_administration_view_admin_grant.sql",
    "0025_sop_assignment_permission.sql",
    "0026_viewer_permissions.sql",
    "0027_viewer_processing_control_plane.sql",
    "0028_viewer_processing_labels.sql",
    "0029_viewer_machine_rate_limits.sql",
    "0030_viewer_client_grant_bridge_rate_limit.sql",
    "0031_project_alpha_delivery_intent_rate_limits.sql",
  ]),
});

// Every additive capability must be present and false in a release-preparation
// configuration. A later, separately approved activation packet may turn on
// one flag only after its matching external gate has current staging evidence.
export const REQUIRED_DISABLED_FEATURE_FLAGS = Object.freeze({
  delivery: Object.freeze([
    "CLIENT_PORTAL_ENABLED",
    "CLIENT_PORTAL_REQUEST_V2_ENABLED",
    "PROJECT_ALPHA_CATALOG_SYNC_ENABLED",
    "PROJECT_ALPHA_PORTAL_SYNC_ENABLED",
    "PROJECT_ALPHA_PRICING_HINTS_ENABLED",
    "CLIENT_REQUEST_ATTACHMENTS_ENABLED",
    "CLIENT_PORTAL_TEAM_ENABLED",
    "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
    "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
    "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "CLIENT_VIEWER_ENABLED",
    "CLIENT_VIEWER_SHARES_ENABLED",
    "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED",
    "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED",
    "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY",
    "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED",
    "CLIENT_DELEGATED_SHARES_ENABLED",
    "CLOUD_TRANSFER_DROPBOX_ENABLED",
    "CLOUD_TRANSFER_GOOGLE_ENABLED",
    "CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED",
  ]),
  operations: Object.freeze([
    "PROJECT_ALPHA_DRAFT_QUOTES_ENABLED",
    "PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED",
    "PROJECT_ALPHA_DELIVERY_GUEST_ENABLED",
    "CLIENT_DELEGATED_SHARE_SIGNER_ENABLED",
    "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
    "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
    "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "VIEWER_INTEGRATION_ENABLED",
    "VIEWER_PROCESSING_ENABLED",
    "VIEWER_PUBLIC_SHARES_ENABLED",
    "CLIENT_VIEWER_SESSION_ISSUER_ENABLED",
    "CLIENT_VIEWER_SHARES_ENABLED",
    "DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED",
    "DIRECT_DELIVERY_UPLOADS_ENABLED",
    "DROPBOX_IMPORT_ENABLED",
    "R2_PURGE_ENABLED",
  ]),
  "ops-sync": Object.freeze([]),
});

export const REQUIRED_EXTERNAL_GATES = Object.freeze([
  "projectAlphaPortalProjection",
  "projectAlphaCatalogProjection",
  "projectAlphaPricingHints",
  "projectAlphaDraftQuotes",
  "requestAttachmentScanner",
  "requestAttachmentR2CorsAndLeastPrivilege",
  "workspaceInvitationEmail",
  "workspaceAccessEnrollment",
  "workspaceStaffRecovery",
  "delegatedShareSignerBinding",
  "delegatedSharePublicAuthorization",
  "trueNasVideoThumbnailRenderer",
  "projectionParityAndAlerts",
  "viewerDeployment",
  "viewerServiceContract",
  "viewerProcessing",
  "viewerPublicShares",
  "viewerClientSessions",
  "viewerClientShares",
]);

// A bare "ready" attestation is not enough for any external capability. These
// proof names are deliberately stable so the ignored evidence packet can be
// validated without storing provider credentials or customer data in Git.
export const REQUIRED_EXTERNAL_GATE_PROOFS = Object.freeze({
  projectAlphaPortalProjection: Object.freeze([
    "fixturesPinned", "orderedReplayVerified", "scopeParityVerified", "tombstoneRemovalVerified",
  ]),
  projectAlphaCatalogProjection: Object.freeze([
    "fixturesPinned", "completeGenerationVerified", "staleRecoveryVerified", "sanitizedFieldsVerified",
  ]),
  projectAlphaPricingHints: Object.freeze([
    "fixturePinned", "safeDegradationVerified", "noLocalFallbackVerified",
  ]),
  projectAlphaDraftQuotes: Object.freeze([
    "fixturePinned", "idempotentReplayVerified", "conflictingReplayDenied",
    "noFinancialSideEffects", "nativeEditorHandoffVerified",
  ]),
  requestAttachmentScanner: Object.freeze([
    "scannerVersionPinned", "quarantineDispatchVerified", "objectDigestBound",
    "cleanAndMaliciousSamplesVerified", "quarantineCleanupVerified", "alertOwnershipVerified",
  ]),
  requestAttachmentR2CorsAndLeastPrivilege: Object.freeze([
    "allowedOriginPutVerified", "outOfScopeOriginDenied", "leastPrivilegeCredentialVerified",
  ]),
  workspaceInvitationEmail: Object.freeze([
    "senderDomainVerified", "bindingRestricted", "deliveryVerified",
    "revocationRaceVerified", "noSensitiveContentVerified",
  ]),
  workspaceAccessEnrollment: Object.freeze([
    "clientGroupIsolated", "enrollmentBeforeEmail", "perInvitationReceiptEnforced",
    "receiptBindsWorkspaceAndEmailHash", "receiptRevocationRaceVerified", "earlyRevocationOrderingVerified",
    "multiWorkspaceRetention", "lastEligibilityRevocation", "staffGroupUnchanged",
  ]),
  workspaceStaffRecovery: Object.freeze([
    "transferBeforeOffboardingVerified", "projectAlphaManagerRemovalDenied",
    "effectiveReplacementVerified", "auditVerified",
  ]),
  delegatedShareSignerBinding: Object.freeze([
    "deployedBindingVerified", "flagPairVerified", "smokeVerified",
  ]),
  delegatedSharePublicAuthorization: Object.freeze([
    "currentStateReauthorizationVerified", "crossWorkspaceDenied", "revocationImmediate",
    "rootApprovalVerified", "bulkCloudCopyDenied",
  ]),
  trueNasVideoThumbnailRenderer: Object.freeze([
    "rendererVersionPinned", "opaqueLeaseVerified", "reclaimedAttemptDenied",
    "videoBypassesCloudflareVerified", "recoveryBackfillVerified", "gracePathsVerified",
  ]),
  projectionParityAndAlerts: Object.freeze([
    "parityThresholdsConfigured", "stalenessAlertConfigured",
    "alertDestinationVerified", "testAlertObserved",
  ]),
  viewerDeployment: Object.freeze([
    "exactCommitAndDigestVerified", "configHashVerified", "secretValuesExcluded",
    "healthAndReadinessVerified", "rootlessRuntimeVerified", "persistentStorageVerified",
    "readOnlyImportsVerified", "rollbackVerified",
  ]),
  viewerServiceContract: Object.freeze([
    "fixturesPinned", "serviceKeyIdsMatched", "eventKeyIdsMatched",
    "exactBodySignaturesVerified", "callbackReplayDenied", "providerOutageViewingVerified",
    "publishedSessionSourceRevocationVerified",
  ]),
  viewerProcessing: Object.freeze([
    "providerCredentialEncrypted", "providerProbeVerified", "admissionBackpressureVerified",
    "durableWorkerHeartbeatVerified", "diskPreflightVerified", "callbackRetryVerified",
    "restartRecoveryVerified", "representativeDatasetVerified",
  ]),
  viewerPublicShares: Object.freeze([
    "expiryVerified", "neverExpireVerified", "passwordRateLimitsVerified",
    "revocationVerified", "hashOnlyAbuseKeysVerified", "rangeNoStoreVerified",
  ]),
  viewerClientSessions: Object.freeze([
    "oneTimeGrantVerified", "scopedSessionVerified", "silentRenewalVerified",
    "refreshFailureStatePreserved", "expiryAndRevocationVerified", "desktopMobileVerified",
  ]),
  viewerClientShares: Object.freeze([
    "explicitEntitlementVerified", "ownerIsolationVerified", "sourceExpiryCapVerified",
    "incomingHmacVerified", "fiveSecondRevocationVerified", "nestedAssetBurstVerified",
    "redactedAuditVerified", "desktopMobileVerified",
  ]),
});

// Every default-off flag is either tied to current evidence gates or explicitly
// prohibited from activation by this release packet. This prevents a later
// operator from treating an unrelated green gate as authorization.
export const FEATURE_FLAG_ACTIVATION_POLICIES = Object.freeze({
  delivery: Object.freeze({
    CLIENT_PORTAL_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "projectionParityAndAlerts"]) }),
    CLIENT_PORTAL_REQUEST_V2_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaCatalogProjection", "projectAlphaPortalProjection"]) }),
    PROJECT_ALPHA_CATALOG_SYNC_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaCatalogProjection", "projectionParityAndAlerts"]) }),
    PROJECT_ALPHA_PORTAL_SYNC_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "projectionParityAndAlerts"]) }),
    PROJECT_ALPHA_PRICING_HINTS_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPricingHints", "projectAlphaCatalogProjection"]) }),
    CLIENT_REQUEST_ATTACHMENTS_ENABLED: Object.freeze({ gates: Object.freeze(["requestAttachmentScanner", "requestAttachmentR2CorsAndLeastPrivilege"]) }),
    CLIENT_PORTAL_TEAM_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "workspaceStaffRecovery"]) }),
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "projectionParityAndAlerts"]) }),
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: Object.freeze({ prohibitedReason: "Identity denylist activation requires a reviewed Operations mutation and audit surface" }),
    CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: Object.freeze({ prohibitedReason: "Automatic Project Alpha email eligibility requires migration 0145 and explicit opt-out onboarding approval" }),
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: Object.freeze({ prohibitedReason: "Authenticated Delivery grants require migration 0137, Project Alpha hierarchy parity, and end-to-end grant/revoke/restore evidence" }),
    CLIENT_VIEWER_ENABLED: Object.freeze({ gates: Object.freeze(["viewerDeployment", "viewerServiceContract", "viewerClientSessions"]), stagingGates: Object.freeze(["viewerDeployment", "viewerServiceContract"]) }),
    CLIENT_VIEWER_SHARES_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "viewerDeployment", "viewerPublicShares", "viewerClientShares"]), stagingGates: Object.freeze(["viewerDeployment", "viewerServiceContract"]) }),
    CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "projectionParityAndAlerts"]) }),
    CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: Object.freeze({ gates: Object.freeze(["workspaceAccessEnrollment", "workspaceStaffRecovery"]) }),
    CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: Object.freeze({ gates: Object.freeze(["workspaceAccessEnrollment"]) }),
    CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: Object.freeze({ gates: Object.freeze(["workspaceAccessEnrollment", "workspaceInvitationEmail"]) }),
    CLIENT_DELEGATED_SHARES_ENABLED: Object.freeze({ gates: Object.freeze(["delegatedShareSignerBinding", "delegatedSharePublicAuthorization"]) }),
    CLOUD_TRANSFER_DROPBOX_ENABLED: Object.freeze({ prohibitedReason: "Dropbox client transfer is outside this release packet" }),
    CLOUD_TRANSFER_GOOGLE_ENABLED: Object.freeze({ prohibitedReason: "Google client transfer is outside this release packet" }),
    CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED: Object.freeze({ prohibitedReason: "Google Picker is outside this release packet" }),
  }),
  operations: Object.freeze({
    PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaDraftQuotes", "projectAlphaCatalogProjection"]) }),
    PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: Object.freeze({ prohibitedReason: "Project Alpha managed delivery requires migration 0069/0147/0031 and an independently approved end-to-end intent, notification, and revocation activation window" }),
    PROJECT_ALPHA_DELIVERY_GUEST_ENABLED: Object.freeze({ prohibitedReason: "Guest delivery remains explicit-only and requires a separate public-bearer notification and revocation approval after the portal intent path is proven" }),
    CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: Object.freeze({ gates: Object.freeze(["delegatedShareSignerBinding", "delegatedSharePublicAuthorization"]) }),
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "projectionParityAndAlerts"]) }),
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: Object.freeze({ prohibitedReason: "Identity denylist activation requires reviewed staging denial and last-manager evidence" }),
    CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: Object.freeze({ prohibitedReason: "Staff deny-policy management remains disabled until Client enforcement and audit evidence are recorded together" }),
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: Object.freeze({ prohibitedReason: "Authenticated Delivery grants require migration 0137 and end-to-end Operations-to-portal evidence" }),
    VIEWER_INTEGRATION_ENABLED: Object.freeze({ gates: Object.freeze(["viewerDeployment", "viewerServiceContract"]), stagingGates: Object.freeze(["viewerDeployment"]) }),
    VIEWER_PROCESSING_ENABLED: Object.freeze({ gates: Object.freeze(["viewerDeployment", "viewerServiceContract", "viewerProcessing"]), stagingGates: Object.freeze(["viewerDeployment", "viewerServiceContract"]) }),
    VIEWER_PUBLIC_SHARES_ENABLED: Object.freeze({ gates: Object.freeze(["viewerDeployment", "viewerPublicShares"]), stagingGates: Object.freeze(["viewerDeployment"]) }),
    CLIENT_VIEWER_SESSION_ISSUER_ENABLED: Object.freeze({ gates: Object.freeze(["viewerDeployment", "viewerServiceContract", "viewerClientSessions"]), stagingGates: Object.freeze(["viewerDeployment", "viewerServiceContract"]) }),
    CLIENT_VIEWER_SHARES_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "viewerDeployment", "viewerPublicShares", "viewerClientShares"]), stagingGates: Object.freeze(["viewerDeployment", "viewerServiceContract"]) }),
    DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED: Object.freeze({ gates: Object.freeze(["projectAlphaPortalProjection", "projectionParityAndAlerts"]) }),
    DIRECT_DELIVERY_UPLOADS_ENABLED: Object.freeze({ prohibitedReason: "Direct Delivery upload activation requires its separate media acceptance packet" }),
    DROPBOX_IMPORT_ENABLED: Object.freeze({ prohibitedReason: "Dropbox import is outside this release packet" }),
    R2_PURGE_ENABLED: Object.freeze({ prohibitedReason: "Permanent purge requires a separate destructive-lifecycle approval" }),
  }),
  "ops-sync": Object.freeze({}),
});

// Some end-to-end staging capabilities are unreachable with a single flag:
// the second flag is a dependency, not a second evidence boundary. These
// exact, closed sets are the only multi-flag windows the evidence validator
// accepts. Production flags still remain off throughout staging collection.
export const FEATURE_FLAG_DEPENDENCY_WINDOWS = Object.freeze({
  viewerProcessing: Object.freeze({
    collectingGate: "viewerProcessing",
    requestedFlags: Object.freeze([
      "operations.VIEWER_INTEGRATION_ENABLED",
      "operations.VIEWER_PROCESSING_ENABLED",
    ]),
    requiresViewerProcessingPlatform: true,
    requiresViewerWorkerProfile: true,
  }),
  viewerPublicShares: Object.freeze({
    collectingGate: "viewerPublicShares",
    requestedFlags: Object.freeze([
      "operations.VIEWER_INTEGRATION_ENABLED",
      "operations.VIEWER_PUBLIC_SHARES_ENABLED",
    ]),
  }),
  viewerClientSessions: Object.freeze({
    collectingGate: "viewerClientSessions",
    requestedFlags: Object.freeze([
      "delivery.CLIENT_VIEWER_ENABLED",
      "operations.VIEWER_INTEGRATION_ENABLED",
      "operations.CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
      "operations.CLIENT_VIEWER_SESSION_ISSUER_ENABLED",
    ]),
    requiresViewerPublishedSessionSourceRevocation: true,
  }),
  viewerClientShares: Object.freeze({
    collectingGate: "viewerClientShares",
    requestedFlags: Object.freeze([
      "delivery.CLIENT_VIEWER_ENABLED",
      "delivery.CLIENT_VIEWER_SHARES_ENABLED",
      "operations.VIEWER_INTEGRATION_ENABLED",
      "operations.VIEWER_PUBLIC_SHARES_ENABLED",
      "operations.CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
      "operations.CLIENT_VIEWER_SESSION_ISSUER_ENABLED",
      "operations.CLIENT_VIEWER_SHARES_ENABLED",
    ]),
    requiresViewerPublishedSessionSourceRevocation: true,
  }),
});

export const STAGING_ACCESS_AUDS = Object.freeze({
  delivery: "f6942c97e306d81d206c94746dc731413d5e59461b35d9b213f13fdf96b62835",
  operations: "e5e2026896677c6fbaa0c7eb9b795e326516c15a3191dfba3c2ad43da4728671",
  "ops-sync": "7b578ad388abb5c5eb550e86ddf3263af0b2a5694e8bf4810c67affa5721ec37",
});

export const STAGING_STATIC_VARS = Object.freeze({
  delivery: Object.freeze({
    TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    PUBLIC_BASE_URL: `https://${STAGING_HOSTS.client}`,
    CLIENT_PORTAL_ENABLED: "false",
    CLIENT_PORTAL_ORIGIN: `https://${STAGING_HOSTS.client}`,
    CLIENT_ACCESS_TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    R2_S3_ENDPOINT: "https://846c924bf17bf4f3dd15c97a4c5d1d51.r2.cloudflarestorage.com",
    R2_BUCKET_NAME: "client-data-staging",
    CLIENT_PORTAL_REQUEST_V2_ENABLED: "false",
    PROJECT_ALPHA_CATALOG_SYNC_ENABLED: "false",
    PROJECT_ALPHA_CATALOG_APPLICATION_KEY: "ltds_client_catalog_staging",
    PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    PROJECT_ALPHA_CATALOG_HMAC_KEY_ID: "catalog-staging-v1",
    PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID: "",
    PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "false",
    PROJECT_ALPHA_PORTAL_APPLICATION_KEY: "ltds_client_portal_staging",
    PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: "portal-staging-v1",
    PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID: "",
    PROJECT_ALPHA_PRICING_HINTS_ENABLED: "false",
    PROJECT_ALPHA_PRICING_HINT_URL: `${STAGING_PROJECT_ALPHA_ORIGIN}/api/v2/integrations/ltds_client_pricing_staging/pricing-hints`,
    PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN: STAGING_PROJECT_ALPHA_ORIGIN,
    PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY: "ltds_client_pricing_staging",
    PROJECT_ALPHA_PRICING_HINT_CURRENCIES: "USD",
    CLIENT_REQUEST_ATTACHMENTS_ENABLED: "false",
    CLIENT_PORTAL_TEAM_ENABLED: "false",
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false",
    CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false",
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "false",
    CLIENT_VIEWER_ENABLED: "false",
    CLIENT_VIEWER_SHARES_ENABLED: "false",
    CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "false",
    CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: "false",
    CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: "false",
    CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "false",
    CLIENT_DELEGATED_SHARES_ENABLED: "false",
    CLIENT_DELEGATED_SHARE_KEY_ID: "staging-v1",
    CLOUD_TRANSFER_DROPBOX_ENABLED: "false",
    CLOUD_TRANSFER_GOOGLE_ENABLED: "false",
    CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED: "false",
  }),
  operations: Object.freeze({
    TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    DELIVERY_BASE_URL: `https://${STAGING_HOSTS.client}`,
    PROJECT_ALPHA_BASE_URL: STAGING_PROJECT_ALPHA_ORIGIN,
    R2_ACCOUNT_ID: STAGING_ACCOUNT_ID,
    R2_BUCKET_NAME: "client-data-staging",
    R2_INCOMING_BUCKET_NAME: "ltds-incoming-staging",
    FILE_EVENTS_QUEUE_NAME: "ltds-file-events-staging",
    THUMBNAIL_QUEUE_NAME: "ltds-thumbnail-jobs-staging",
    THUMBNAIL_DLQ_NAME: "ltds-thumbnail-jobs-staging-dlq",
    THUMBNAIL_INGEST_EXPECTED_HOST: STAGING_HOSTS.operations,
    THUMBNAIL_RENDERER_EXPECTED_HOST: STAGING_HOSTS.incoming,
    APPLICATION_KEY: "ltds_ops_staging",
    PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "false",
    PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: "false",
    PROJECT_ALPHA_DELIVERY_GUEST_ENABLED: "false",
    CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "false",
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false",
    CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "false",
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "false",
    VIEWER_INTEGRATION_ENABLED: "false",
    VIEWER_PROCESSING_ENABLED: "false",
    VIEWER_PUBLIC_SHARES_ENABLED: "false",
    VIEWER_BASE_URL: "https://viewer-staging.ledgetopdroneservices.com",
    VIEWER_SERVICE_KEY_ID: "ops-staging-v1",
    VIEWER_EVENT_KEY_ID: "viewer-staging-v1",
    VIEWER_EVENT_PREVIOUS_KEY_ID: "",
    DEFAULT_UNITS: "imperial",
    CLIENT_VIEWER_SESSION_ISSUER_ENABLED: "false",
    CLIENT_VIEWER_SHARES_ENABLED: "false",
    DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED: "false",
    DIRECT_DELIVERY_UPLOADS_ENABLED: "false",
    DROPBOX_IMPORT_ENABLED: "false",
    R2_PURGE_ENABLED: "false",
  }),
  "ops-sync": Object.freeze({
    TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
    CF_ACCOUNT_ID: STAGING_ACCOUNT_ID,
    APPLICATION_KEY: "ltds_ops_staging",
    PROJECT_ALPHA_ALLOW_LEGACY_HMAC: "true",
  }),
});

export const STAGING_ALLOWED_VAR_NAMES = Object.freeze({
  delivery: Object.freeze([
    "PUBLIC_BASE_URL", "EXPECTED_HOST", "ENVIRONMENT", "TEAM_DOMAIN", "POLICY_AUD",
    "CLIENT_PORTAL_ENABLED", "CLIENT_PORTAL_REQUEST_V2_ENABLED",
    "PROJECT_ALPHA_CATALOG_SYNC_ENABLED", "PROJECT_ALPHA_CATALOG_APPLICATION_KEY",
    "PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN", "PROJECT_ALPHA_CATALOG_ACCESS_AUD",
    "PROJECT_ALPHA_CATALOG_HMAC_KEY_ID", "PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID",
    "PROJECT_ALPHA_PORTAL_SYNC_ENABLED", "PROJECT_ALPHA_PORTAL_APPLICATION_KEY",
    "PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN", "PROJECT_ALPHA_PORTAL_ACCESS_AUD",
    "PROJECT_ALPHA_PORTAL_HMAC_KEY_ID", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID",
    "PROJECT_ALPHA_PRICING_HINTS_ENABLED", "PROJECT_ALPHA_PRICING_HINT_URL",
    "PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN", "PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY",
    "PROJECT_ALPHA_PRICING_HINT_CURRENCIES", "CLIENT_REQUEST_ATTACHMENTS_ENABLED",
    "CLIENT_PORTAL_TEAM_ENABLED", "CLIENT_PORTAL_HIERARCHY_V2_ENABLED", "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
    "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "CLIENT_VIEWER_ENABLED", "CLIENT_VIEWER_SHARES_ENABLED",
    "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED", "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED",
    "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY", "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED",
    "CLIENT_PORTAL_INVITATION_FROM", "CLIENT_PORTAL_INVITATION_FROM_NAME",
    "CLIENT_DELEGATED_SHARES_ENABLED", "CLIENT_DELEGATED_SHARE_KEY_ID",
    "CLIENT_PORTAL_ORIGIN", "CLIENT_ACCESS_TEAM_DOMAIN", "CLIENT_ACCESS_AUD",
    "MAPBOX_PUBLIC_TOKEN", "SESSION_KEY_ID", "PREVIOUS_SESSION_KEY_ID",
    "STREAM_CUSTOMER_CODE", "R2_S3_ENDPOINT", "R2_BUCKET_NAME",
    "CLOUD_TRANSFER_DROPBOX_ENABLED", "CLOUD_TRANSFER_GOOGLE_ENABLED",
    "CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED", "DROPBOX_CLIENT_ID",
    "GOOGLE_CLIENT_ID", "GOOGLE_PICKER_API_KEY", "GOOGLE_CLOUD_PROJECT_NUMBER",
  ]),
  operations: Object.freeze([
    "PUBLIC_BASE_URL", "EXPECTED_HOST", "DIRECT_DELIVERY_UPLOADS_ENABLED",
    "INCOMING_BASE_URL", "INCOMING_EXPECTED_HOST", "THUMBNAIL_INGEST_EXPECTED_HOST", "THUMBNAIL_RENDERER_EXPECTED_HOST",
    "ENVIRONMENT", "TEAM_DOMAIN", "OPERATIONS_AUD", "DELIVERY_BASE_URL",
    "PROJECT_ALPHA_BASE_URL", "PROJECT_ALPHA_DRAFT_QUOTES_ENABLED",
    "PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED", "PROJECT_ALPHA_DELIVERY_GUEST_ENABLED",
    "CLIENT_DELEGATED_SHARE_SIGNER_ENABLED", "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
    "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED", "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
    "VIEWER_INTEGRATION_ENABLED", "VIEWER_PROCESSING_ENABLED", "VIEWER_PUBLIC_SHARES_ENABLED", "VIEWER_BASE_URL",
    "VIEWER_SERVICE_KEY_ID", "VIEWER_EVENT_KEY_ID", "VIEWER_EVENT_PREVIOUS_KEY_ID", "DEFAULT_UNITS",
    "CLIENT_VIEWER_SESSION_ISSUER_ENABLED", "CLIENT_VIEWER_SHARES_ENABLED",
    "DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED", "APPLICATION_KEY", "TFR_REGION",
    "DISPLAY_TIMEZONE", "MAP_STYLE_URL", "MAPBOX_PUBLIC_TOKEN", "STREAM_ACCOUNT_ID",
    "STREAM_CUSTOMER_CODE", "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_PURGE_ENABLED",
    "R2_INCOMING_BUCKET_NAME", "FILE_EVENTS_QUEUE_NAME", "THUMBNAIL_QUEUE_NAME",
    "THUMBNAIL_DLQ_NAME", "ALERT_FROM", "ALERT_TO", "NOTIFICATION_FROM",
    "CLIENT_REQUEST_TRIAGE_TO", "DROPBOX_IMPORT_ENABLED", "DROPBOX_CLIENT_ID",
  ]),
  "ops-sync": Object.freeze([
    "ENVIRONMENT", "EXPECTED_HOST", "TEAM_DOMAIN", "CF_ACCESS_AUD", "CF_ACCOUNT_ID",
    "CF_ACCESS_GROUP_ID", "CF_ACCESS_GROUP_NAME", "APPLICATION_KEY",
    "PROJECT_ALPHA_ALLOW_LEGACY_HMAC",
  ]),
});

export const STAGING_INVENTORY = Object.freeze({
  delivery: {
    name: "ltds-delivery-staging",
    main: "src/worker/index.ts",
    compatibility_date: "2026-07-16",
    compatibility_flags: ["nodejs_compat"],
    routes: [
      { pattern: STAGING_HOSTS.delivery, custom_domain: true },
      { pattern: STAGING_HOSTS.client, custom_domain: true },
    ],
    d1_databases: [{ binding: "DELIVERY_DB", database_name: "client-data-staging", database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "DATA_BUCKET", bucket_name: "client-data-staging" }],
    workflows: [
      { name: "ltds-bulk-download-staging", binding: "BULK_DOWNLOAD_WORKFLOW", class_name: "BulkDownloadWorkflow" },
      { name: "ltds-cloud-transfer-staging", binding: "CLOUD_TRANSFER_WORKFLOW", class_name: "CloudTransferWorkflow" },
    ],
    services: [
      { binding: "CLIENT_DELEGATED_SHARE_SIGNER", service: "ltds-ops-staging", entrypoint: "ClientDelegatedShareSigner" },
      { binding: "VIEWER_SESSION_ISSUER", service: "ltds-ops-staging", entrypoint: "ViewerSessionIssuer" },
    ],
    queues: [],
    crons: ["*/5 * * * *", "15 * * * *"],
    limits: { cpu_ms: 300000, subrequests: 25000 },
    assets: { binding: "ASSETS", directory: "./dist/client", not_found_handling: "single-page-application", run_worker_first: ["/", "/api/*", "/s/*", "/client-share/*", "/health"] },
    observability: { enabled: true, head_sampling_rate: 1 },
    stream: { binding: "STREAM" },
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
    main: "src/worker/index.ts",
    compatibility_date: "2026-07-22",
    compatibility_flags: ["nodejs_compat"],
    routes: [{ pattern: STAGING_HOSTS.operations, custom_domain: true }],
    d1_databases: [
      { binding: "OPS_DB", database_name: "ltds-ops-staging", database_id: "78b34173-b168-4e3d-9832-bb9d245cc6b8", migrations_dir: "migrations" },
      { binding: "DELIVERY_DB", database_name: "client-data-staging", database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb", migrations_dir: "../client/migrations" },
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
    services: [],
    queues: [
      { queue: "ltds-file-events-staging", max_batch_size: 25, max_batch_timeout: 10, max_retries: 5, dead_letter_queue: "ltds-file-events-staging-dlq" },
      { queue: "ltds-thumbnail-jobs-staging", max_batch_size: 10, max_batch_timeout: 5, max_retries: 5, max_concurrency: 1, dead_letter_queue: "ltds-thumbnail-jobs-staging-dlq" },
      { queue: "ltds-thumbnail-jobs-staging-dlq", max_batch_size: 10, max_batch_timeout: 5 },
    ],
    queueProducers: [
      { binding: "THUMBNAIL_QUEUE", queue: "ltds-thumbnail-jobs-staging" },
    ],
    crons: ["*/15 * * * *", "*/5 * * * *"],
    assets: { binding: "ASSETS", directory: "./dist/client", not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/health", "/r/*"] },
    observability: { enabled: true, head_sampling_rate: 1 },
    stream: { binding: "STREAM" },
    durable_objects: { bindings: [{ name: "THUMBNAIL_RENDERER", class_name: "ThumbnailRendererContainer" }] },
    exports: { ThumbnailRendererContainer: { type: "durable-object", storage: "sqlite" } },
    containers: [{ class_name: "ThumbnailRendererContainer", image: "./containers/thumbnail-renderer/Dockerfile", max_instances: 1, instance_type: "standard-1", constraints: { regions: ["WNAM"] }, ssh: { enabled: false } }],
    ratelimits: [],
  },
  "ops-sync": {
    name: "ltds-ops-sync-staging",
    main: "src/index.ts",
    compatibility_date: "2026-07-22",
    compatibility_flags: ["nodejs_compat"],
    routes: [{ pattern: STAGING_HOSTS["ops-sync"], custom_domain: true }],
    d1_databases: [
      { binding: "OPS_DB", database_name: "ltds-ops-staging", database_id: "78b34173-b168-4e3d-9832-bb9d245cc6b8", migrations_dir: "../operations/migrations" },
      { binding: "DELIVERY_DB", database_name: "client-data-staging", database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb", migrations_dir: "../client/migrations" },
    ],
    r2_buckets: [],
    workflows: [],
    services: [],
    queues: [],
    crons: ["*/5 * * * *"],
    observability: { enabled: true, head_sampling_rate: 1 },
    ratelimits: [],
  },
});
