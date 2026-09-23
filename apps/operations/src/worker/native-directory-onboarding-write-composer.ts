import { writeNativeDirectoryProfile, type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome } from "./native-directory-profile-writer";
import { writeNativeDirectoryRelationship, type NativeDirectoryRelationshipWrite,
  type NativeDirectoryRelationshipWriteOutcome } from "./native-directory-relationship-writer";

type WrittenProfile = Extract<NativeDirectoryProfileWriteOutcome, { status: "written" }>;
type WrittenRelationship = Extract<NativeDirectoryRelationshipWriteOutcome, { status: "written" }>;
export type NativeDirectoryOnboardingWriteExecution =
  | Readonly<{ status: "written"; relationship: WrittenRelationship; profile: WrittenProfile }>
  | Readonly<{ status: "blocked"; reason: "atomic_write" }>;

/**
 * Presents a writer with an otherwise-normal first-primary session while
 * retaining its complete batch inside this module. Writers therefore keep a
 * high-level API and cannot hand prepared statements or a raw DB capability to
 * callers merely to participate in the onboarding transaction.
 */
function recordingSession(session: D1DatabaseSession): Readonly<{
  db: D1Database;
  statements: () => readonly D1PreparedStatement[] | null;
}> {
  let recorded: readonly D1PreparedStatement[] | null = null;
  const db = new Proxy(session, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (recorded !== null) throw new Error("native Directory writer issued multiple batches");
      recorded = [...statements];
      return [];
    };
    const member = target[property as keyof D1DatabaseSession];
    return typeof member === "function" ? member.bind(target) : member;
  } }) as unknown as D1Database;
  return { db, statements: () => recorded };
}

/** Plans both writes against one first-primary handle, then executes one batch. */
export async function planAndExecuteNativeDirectoryOnboardingWrites(db: D1Database,
  relationshipInput: NativeDirectoryRelationshipWrite,
  profileInput: NativeDirectoryProfileWrite): Promise<NativeDirectoryOnboardingWriteExecution |
    NativeDirectoryRelationshipWriteOutcome | NativeDirectoryProfileWriteOutcome> {
  const session = db.withSession("first-primary");
  const relationshipRecording = recordingSession(session);
  const relationship = await writeNativeDirectoryRelationship(relationshipRecording.db, relationshipInput);
  const relationshipStatements = relationshipRecording.statements();
  if (relationship.status !== "written" || relationshipStatements === null) return relationship;
  const profileRecording = recordingSession(session);
  const profile = await writeNativeDirectoryProfile(profileRecording.db, profileInput);
  const profileStatements = profileRecording.statements();
  if (profile.status !== "written" || profileStatements === null) return profile;
  try { await session.batch([...relationshipStatements, ...profileStatements]); }
  catch { return { status: "blocked", reason: "atomic_write" }; }
  return { status: "written", relationship: relationship as WrittenRelationship, profile: profile as WrittenProfile };
}
