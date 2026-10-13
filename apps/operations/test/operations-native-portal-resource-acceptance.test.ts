import { describe, it } from "vitest";
import { runCanonicalPortalResourceAcceptance } from "./helpers/operations-native-portal-resource-acceptance-fixture";

describe("Ops Delivery to authenticated Client portal resource acceptance", { timeout: 300_000 }, () => {
  it("denies unenrolled and cross-tenant principals, resolves only the enrolled workspace, and preserves public shares",
    () => runCanonicalPortalResourceAcceptance(undefined,{operationsThroughMigration:"0203_effective_native_directory_enrollment_consumers.sql"}));
});
