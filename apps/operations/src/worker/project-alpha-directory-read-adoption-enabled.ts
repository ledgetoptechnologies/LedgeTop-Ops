import type { Env } from "./types";

type AdoptionGateEnvironment = Readonly<{
  ENVIRONMENT?: string;
  PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED?: string;
  PROJECT_ALPHA_DIRECTORY_EXISTING_RECORD_ADOPTION_ENABLED?: string;
}>;

/** Preserve the reviewed staging window while allowing the exact-record
 * workflow to be enabled independently as a normal operational capability. */
export function projectAlphaDirectoryExistingRecordAdoptionEnabled(env: AdoptionGateEnvironment): boolean {
  return env.PROJECT_ALPHA_DIRECTORY_EXISTING_RECORD_ADOPTION_ENABLED === "true"
    || (env.ENVIRONMENT === "staging" && env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED === "true");
}
