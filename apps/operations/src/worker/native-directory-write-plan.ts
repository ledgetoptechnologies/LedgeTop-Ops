/**
 * Keeps native Directory D1 statements private to their planner. Consumers may
 * inspect the proposed outcome, but only trusted executors can retrieve the
 * complete statement set.
 */
declare const nativeDirectoryWritePlanBrand: unique symbol;

export type OpaqueNativeDirectoryWritePlan<Outcome> = Readonly<{
  status: "planned";
  outcome: Outcome;
  readonly [nativeDirectoryWritePlanBrand]: never;
}>;

type PlanKind = "profile" | "relationship";
type StoredPlan = Readonly<{ kind: PlanKind; statements: readonly D1PreparedStatement[] }>;
const storedPlans = new WeakMap<object, StoredPlan>();

export function nativeDirectoryWritePlan<Outcome>(kind: PlanKind, outcome: Outcome,
  statements: readonly D1PreparedStatement[]): OpaqueNativeDirectoryWritePlan<Outcome> {
  const plan = { status: "planned" as const, outcome } as OpaqueNativeDirectoryWritePlan<Outcome>;
  storedPlans.set(plan, { kind, statements: [...statements] });
  return plan;
}

export function nativeDirectoryWritePlanStatements(plan: object, kind: PlanKind): readonly D1PreparedStatement[] | null {
  const stored = storedPlans.get(plan);
  return stored?.kind === kind ? stored.statements : null;
}

/** Preserves existing single-writer execution semantics without exposing statements. */
export async function executeNativeDirectoryWritePlan(db: Pick<D1Database, "batch">,
  plan: object, kind: PlanKind): Promise<boolean> {
  const statements = nativeDirectoryWritePlanStatements(plan, kind);
  if (statements === null) return false;
  await db.batch([...statements]);
  return true;
}
