/** Dormant API-v2 client organization relationship transport. */
export {
  isProjectAlphaDirectoryRelationshipCommand,
  sendProjectAlphaDirectoryOrganizationRelationshipCommand,
  sendConfiguredProjectAlphaDirectoryOrganizationRelationshipCommand,
  sendProjectAlphaDirectoryRelationshipCommand,
  sendConfiguredProjectAlphaDirectoryRelationshipCommand,
  validatedProjectAlphaDirectoryCommandAcknowledgement,
  validatedProjectAlphaDirectoryRelationshipGenerationConflict,
} from "./project-alpha-directory-command-api-v2";
export type {
  ProjectAlphaDirectoryRelationshipAction,
  ProjectAlphaDirectoryRelationshipCommand,
  ProjectAlphaDirectoryCommand,
  ProjectAlphaDirectoryRelationshipSuccess,
  ProjectAlphaDirectoryRelationshipOutcome,
  ProjectAlphaDirectoryRelationshipGenerationConflict,
} from "./project-alpha-directory-command-api-v2";
