import type { NativeDirectoryProfileWritePlan } from "./native-directory-profile-writer";
import type { NativeDirectoryRelationshipWritePlan } from "./native-directory-relationship-writer";
import { planNativeDirectoryProfileWrite } from "./native-directory-profile-writer";
import { planNativeDirectoryRelationshipWrite } from "./native-directory-relationship-writer";
import { nativeDirectoryWritePlanStatements } from "./native-directory-write-plan";

export type NativeDirectoryOnboardingWritePlans = Readonly<{
  relationship: NativeDirectoryRelationshipWritePlan;
  profile: NativeDirectoryProfileWritePlan;
}>;
export type NativeDirectoryOnboardingWriteExecution =
  | Readonly<{ status: "written"; relationship: NativeDirectoryRelationshipWritePlan["outcome"]; profile: NativeDirectoryProfileWritePlan["outcome"] }>
  | Readonly<{ status: "rejected"; reason: "invalid_plan" }>
  | Readonly<{ status: "blocked"; reason: "atomic_write" }>;

/**
 * Executes exactly one ordered first-primary D1 batch. Relationship writes
 * always precede profile writes, and opaque plans cannot be split or reordered
 * by a caller.
 */
export async function executeNativeDirectoryOnboardingWritePlans(db: D1Database,
  plans: NativeDirectoryOnboardingWritePlans): Promise<NativeDirectoryOnboardingWriteExecution> {
  const relationship = nativeDirectoryWritePlanStatements(plans.relationship, "relationship");
  const profile = nativeDirectoryWritePlanStatements(plans.profile, "profile");
  if (relationship === null || profile === null) return { status: "rejected", reason: "invalid_plan" };
  try { await db.withSession("first-primary").batch([...relationship, ...profile]); }
  catch { return { status: "blocked", reason: "atomic_write" }; }
  return { status: "written", relationship: plans.relationship.outcome, profile: plans.profile.outcome };
}

/** Plans both writes against one first-primary handle, then executes one batch. */
export async function planAndExecuteNativeDirectoryOnboardingWrites(db: D1Database,
  relationshipInput: Parameters<typeof planNativeDirectoryRelationshipWrite>[1],
  profileInput: Parameters<typeof planNativeDirectoryProfileWrite>[1]): Promise<NativeDirectoryOnboardingWriteExecution | Exclude<Awaited<ReturnType<typeof planNativeDirectoryRelationshipWrite>>, NativeDirectoryRelationshipWritePlan> | Exclude<Awaited<ReturnType<typeof planNativeDirectoryProfileWrite>>, NativeDirectoryProfileWritePlan>> {
  const session = db.withSession("first-primary");
  const relationship = await planNativeDirectoryRelationshipWrite(session, relationshipInput);
  if (relationship.status !== "planned") return relationship;
  const profile = await planNativeDirectoryProfileWrite(session, profileInput);
  if (profile.status !== "planned") return profile;
  return executeNativeDirectoryOnboardingWritePlansWithSession(session, { relationship, profile });
}

async function executeNativeDirectoryOnboardingWritePlansWithSession(session: D1DatabaseSession,
  plans: NativeDirectoryOnboardingWritePlans): Promise<NativeDirectoryOnboardingWriteExecution> {
  const relationship = nativeDirectoryWritePlanStatements(plans.relationship, "relationship");
  const profile = nativeDirectoryWritePlanStatements(plans.profile, "profile");
  if (relationship === null || profile === null) return { status: "rejected", reason: "invalid_plan" };
  try { await session.batch([...relationship, ...profile]); }
  catch { return { status: "blocked", reason: "atomic_write" }; }
  return { status: "written", relationship: plans.relationship.outcome, profile: plans.profile.outcome };
}
