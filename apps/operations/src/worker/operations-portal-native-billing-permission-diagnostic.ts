/** Private staging observability only: never return errors, identities or bind values. */
export type BillingPermissionDiagnostic = Readonly<{
  event: "native-billing-permission-batch-failed";
  classification: "command-guard" | "issue-guard" | "revoke-guard" | "generation-guard"
    | "unique-constraint" | "foreign-key-constraint" | "check-constraint" | "unknown";
  action: "issue" | "revoke";
  managerCurrent: boolean | null;
  generationMatches: boolean | null;
  grantIdExists: boolean | null;
  operationIdExists: boolean | null;
  verifiedUntilCanonical: boolean;
  verifiedUntilFuture: boolean | null;
  observedAtFresh: boolean | null;
}>;
export type BillingPermissionDiagnosticOptions = Readonly<{
  environment: string;
  enabled?: string;
  emit: (event: BillingPermissionDiagnostic) => void;
}>;
export function billingPermissionDiagnosticEnabled(environment: string, flag: string | undefined): boolean {
  return environment === "staging" && flag === "true";
}
export function classifyBillingPermissionBatchError(error: unknown): BillingPermissionDiagnostic["classification"] {
  // Provider wrappers may retain the SQLite message as a cause. Only fixed labels escape.
  const messages: string[] = [];
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string") messages.push(message);
      const cause = error.cause;
      if (cause instanceof Error) {
        const causeMessage = cause.message;
        if (typeof causeMessage === "string") messages.push(causeMessage);
      }
    }
  } catch { return "unknown"; }
  const known = [
    ["native billing permission command is not currently authorized and exact", "command-guard"],
    ["native billing permission issue is not exact", "issue-guard"],
    ["native billing permission revoke is not exact", "revoke-guard"],
    ["native billing permission generation transition is invalid", "generation-guard"],
    ["UNIQUE constraint failed", "unique-constraint"],
    ["FOREIGN KEY constraint failed", "foreign-key-constraint"],
    ["CHECK constraint failed", "check-constraint"],
  ] as const;
  for (const [literal, label] of known) if (messages.some(message => message.includes(literal))) return label;
  return "unknown";
}
