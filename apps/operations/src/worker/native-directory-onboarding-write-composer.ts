import { stageNativeDirectoryProfileWrite, type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome } from "./native-directory-profile-writer";
import { stageNativeDirectoryRelationshipWrite, type NativeDirectoryRelationshipWrite,
  type NativeDirectoryRelationshipWriteOutcome } from "./native-directory-relationship-writer";

type WrittenProfile = Extract<NativeDirectoryProfileWriteOutcome, { status: "written" }>;
type WrittenRelationship = Extract<NativeDirectoryRelationshipWriteOutcome, { status: "written" }>;
export type NativeDirectoryOnboardingWriteExecution =
  | Readonly<{ status: "written"; relationship: WrittenRelationship; profile: WrittenProfile }>
  | Readonly<{ status: "blocked"; reason: "atomic_write" }>;

/** Plans both writes against one first-primary handle, then executes one batch. */
export async function planAndExecuteNativeDirectoryOnboardingWrites(db: D1Database,
  relationshipInput: NativeDirectoryRelationshipWrite,
  profileInput: NativeDirectoryProfileWrite): Promise<NativeDirectoryOnboardingWriteExecution |
    NativeDirectoryRelationshipWriteOutcome | NativeDirectoryProfileWriteOutcome> {
  const session = db.withSession("first-primary");
  let relationshipStatements: readonly D1PreparedStatement[] | null = null;
  const relationship = await stageNativeDirectoryRelationshipWrite(session, relationshipInput,
    statements => { relationshipStatements = statements; });
  if (relationshipStatements === null) return relationship;
  let profileStatements: readonly D1PreparedStatement[] | null = null;
  const profile = await stageNativeDirectoryProfileWrite(session, profileInput,
    statements => { profileStatements = statements; });
  if (profileStatements === null) return profile;
  try { await session.batch([...relationshipStatements, ...profileStatements]); }
  catch { return { status: "blocked", reason: "atomic_write" }; }
  return { status: "written", relationship: relationship as WrittenRelationship, profile: profile as WrittenProfile };
}
