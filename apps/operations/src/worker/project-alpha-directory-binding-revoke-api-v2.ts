/** Dormant API-v2 directory binding authority-revoke transport. */
export {
  isProjectAlphaDirectoryBindingRevokeCommand,
  sendProjectAlphaDirectoryBindingRevokeCommand,
  sendConfiguredProjectAlphaDirectoryBindingRevokeCommand,
  validatedProjectAlphaDirectoryCommandAcknowledgement,
} from "./project-alpha-directory-command-api-v2";
export type {
  ProjectAlphaDirectoryCommandKind,
  ProjectAlphaDirectoryBindingRevokeCommand,
  ProjectAlphaDirectoryCommand,
  ProjectAlphaDirectoryBindingRevokeSuccess,
  ProjectAlphaDirectoryBindingRevokeOutcome,
} from "./project-alpha-directory-command-api-v2";
