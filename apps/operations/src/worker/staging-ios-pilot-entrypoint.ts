// Review-only staging wrapper. No deployment configuration selects this module.
// It preserves the existing staging HTTP handler and named exports while adding
// the isolated, default-closed service binding entrypoint for a future rollout.
// Production and the standard staging entrypoint remain unchanged.
export { default } from './staging-native-authority-entrypoint';
// Module helper constants are not Worker entrypoints and must not be exported
// from a Workerd main. Keep the staging runtime list explicit and reviewable.
export {
  ClientDelegatedShareSigner, ClientOnboardingRecipientBridge, ClientPortalNativeFinancialReader,
  ClientPortalRecipientEnrollmentBridge, ClientPortalServiceMetadataReader, DropboxImportWorkflow,
  IncomingRclonePromotionWorkflow, IncomingUploadLifecycleWorkflow,
  OperationsPortalNativeDeliveryAuthorizationReader, OperationsPortalNativeRecipientEnrollmentIngress,
  ProjectAlphaCatalogPromotionWorkflow, ProjectAlphaDeliveryIntentIngress, R2CrudWorkflow,
  SharedProfilePortalIngress, StaffDirectory, ThumbnailRendererContainer, ViewerSessionIssuer,
} from './staging-native-authority-entrypoint';
export { IosPilotReadService } from './ios-pilot-read-entrypoint';
