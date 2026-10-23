// Reviewed module-library exports are distinct from Workerd runtime entrypoints.
// This policy applies only to generated Windows staging mains, never production mains.
export const WINDOWS_STAGING_EXPORT_POLICY = Object.freeze({
  operations: Object.freeze({
    runtime: Object.freeze([
      'ClientDelegatedShareSigner', 'ClientOnboardingRecipientBridge', 'ClientPortalNativeFinancialReader',
      'ClientPortalRecipientEnrollmentBridge', 'ClientPortalServiceMetadataReader', 'DropboxImportWorkflow',
      'IncomingRclonePromotionWorkflow', 'IncomingUploadLifecycleWorkflow',
      'OperationsPortalNativeDeliveryAuthorizationReader', 'OperationsPortalNativeRecipientEnrollmentIngress',
      'ProjectAlphaCatalogPromotionWorkflow', 'ProjectAlphaDeliveryIntentIngress', 'R2CrudWorkflow',
      'SharedProfilePortalIngress', 'ThumbnailRendererContainer', 'ViewerSessionIssuer',
    ]),
    helpers: Object.freeze([
      'NATIVE_DIRECTORY_OUTBOX_CRON', 'NATIVE_DIRECTORY_RECONCILIATION_CRON', 'PROJECT_ALPHA_API_V2_MONITOR_CRON',
      'dispatchThumbnailRendererApi', 'projectAlphaProjectionApiRequest', 'runScheduledPrimaryProjectAlphaSync',
    ]),
  }),
  delivery: Object.freeze({
    runtime: Object.freeze([
      'BulkDownloadWorkflow', 'ClientAuthorityWorkspaceBindingIngress', 'ClientPortalAuthorityV2Ingress',
      'CloudTransferWorkflow', 'OperationsPortalNativeDeliveryAuthorityIngress', 'OperationsPortalNativeRecipientAuthorityIngress',
      'OperationsPortalWorkspacePublicationIngress', 'OpsInventoryCatalogPromotionCoordinator', 'OpsInventoryCatalogStagingIngress',
      'OpsPortalAccessAuthorityIngress', 'OpsSyncPortalProjectionIngress', 'SharedProfilePortalAuthorityReader',
      'VerifiedRecipientDeliveryAuthorityIngress',
    ]),
    helpers: Object.freeze([
      'authenticatedPreviewFrameAllowed', 'bulkDownloadResumeExpiresAt', 'bulkJobProgress', 'bulkQuotaRetryAfterSeconds',
      'classifyPublicRateLimit', 'cleanupTemporaryZips', 'cloudTransferResumeOrigin', 'deliverySecurityHeaders',
      'ensurePublicId', 'framePolicyForPath', 'friendlyBulkFailure', 'markUnavailableFolder', 'readyBulkJobIsExpired',
      'requestHostAllowed', 'requireSameOrigin', 'serveAppShell', 'sourceUrlForItem', 'streamItem',
    ]),
  }),
});

export function assertWindowsStagingRuntimeExports(app, baseline, candidate) {
  const policy = WINDOWS_STAGING_EXPORT_POLICY[app];
  if (!policy || !Array.isArray(baseline) || !Array.isArray(candidate)) throw Error('windows_staging_export_policy_invalid');
  const same = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  if (!same(baseline, ['default', ...policy.runtime, ...policy.helpers])) throw Error('windows_staging_source_exports_unreviewed');
  if (!same(candidate, ['default', ...policy.runtime])) throw Error('windows_staging_runtime_exports_changed');
  return { runtimeExportsPreserved: true, excludedModuleHelpers: [...policy.helpers] };
}
