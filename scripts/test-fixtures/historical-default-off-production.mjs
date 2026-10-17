// Test fixtures for historical staging activation tools, not current production intent.
// Keep the tools' production-off guards intact after the production rollout.
const historicalGates = Object.freeze({
  "ledgetop-clients": Object.freeze([
    "CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED",
    "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
    "CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED",
  ]),
  "ledgetop-ops": Object.freeze([
    "PROJECT_ALPHA_API_V2_SYNC_ENABLED",
    "PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED",
    "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED",
    "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED",
    "OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED",
    "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED",
    "CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED",
    "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
    "CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED",
  ]),
});

export function historicalDefaultOffProduction(config) {
  const flags = historicalGates[config.name];
  if (!flags) throw new Error("historical production fixture requires an exact production Worker name");
  const historical = structuredClone(config);
  for (const flag of flags) historical.vars[flag] = "false";
  // This optional gate was absent before the directory-adoption rollout.
  if (config.name === "ledgetop-ops") delete historical.vars.PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED;
  if (config.name === "ledgetop-clients") {
    // These production host assertions were absent from the historical templates.
    delete historical.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_EXPECTED_HOST;
    delete historical.vars.CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST;
  }
  return historical;
}
