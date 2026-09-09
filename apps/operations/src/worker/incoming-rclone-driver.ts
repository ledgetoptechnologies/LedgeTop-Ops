/**
 * Bounded durable-workflow driver for the promotion journal.  This is not a
 * Workflow entrypoint or route: integration must create a fresh workflow from
 * the returned continuation when a segment ends.
 */
import { resumeIncomingRclonePromotionStep, type IncomingPromotionStatus } from "./incoming-rclone-promotion";
import type { WorkflowStep } from "cloudflare:workers";
import type { IncomingEnv } from "./incoming";

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,200}$/;
export const INCOMING_PROMOTION_DRIVER_MAX_OPERATIONS = 16;
export const INCOMING_PROMOTION_DRIVER_MAX_TRANSIENTS = 3;

export type IncomingPromotionWorkflowStep = Pick<WorkflowStep, "do" | "sleep">;

// Compile-time adapter proof: a real WorkflowStep is accepted without a cast.
export function incomingPromotionWorkflowStep(step: WorkflowStep): IncomingPromotionWorkflowStep { return step; }

const STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes",
} as const;

export type IncomingPromotionContinuation = {
  uploadId: string;
  segment: number;
  reason: "operation_budget" | "transient_retry_exhausted";
};

export type IncomingPromotionDriverResult =
  | { kind: "terminal"; status: IncomingPromotionStatus }
  | { kind: "continue"; continuation: IncomingPromotionContinuation; lastStatus: IncomingPromotionStatus | null };

export type IncomingPromotionDriverDependencies = {
  resume?(env: IncomingEnv, uploadId: string): Promise<IncomingPromotionStatus>;
};

function terminal(status: IncomingPromotionStatus): boolean {
  // `publishing` is deliberately terminal for automatic execution: multipart
  // completion may have succeeded while its acknowledgement was lost. Replaying
  // it could release a second ready object before rclone MOVE removes the first.
  return status.state === "ready" || status.state === "unavailable" || status.state === "failed" || status.state === "publishing";
}

function validateInput(input: { uploadId: string; segment?: number; maxOperations?: number }): { segment: number; maxOperations: number } {
  if (!OPAQUE_ID.test(input.uploadId)) throw new Error("Invalid incoming promotion upload id");
  const segment = input.segment ?? 0;
  const maxOperations = input.maxOperations ?? INCOMING_PROMOTION_DRIVER_MAX_OPERATIONS;
  if (!Number.isSafeInteger(segment) || segment < 0 || segment > 1_000_000) throw new Error("Invalid incoming promotion segment");
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > INCOMING_PROMOTION_DRIVER_MAX_OPERATIONS) throw new Error("Invalid incoming promotion operation budget");
  return { segment, maxOperations };
}

/**
 * Runs at most `maxOperations` durable resume calls. A 10,000-part object must
 * therefore be dispatched through many segments; no global Workflow step or
 * subrequest limit is assumed here. `step.sleep` backoff does not consume the
 * Workflow step quota, while each `step.do` is intentionally bounded.
 */
export async function runIncomingRclonePromotionDriver(
  env: IncomingEnv,
  input: { uploadId: string; segment?: number; maxOperations?: number },
  step: IncomingPromotionWorkflowStep,
  dependencies: IncomingPromotionDriverDependencies = {},
): Promise<IncomingPromotionDriverResult> {
  const { segment, maxOperations } = validateInput(input);
  const resume = dependencies.resume ?? resumeIncomingRclonePromotionStep;
  let lastStatus: IncomingPromotionStatus | null = null;
  let transientCount = 0;

  for (let operation = 0; operation < maxOperations; operation += 1) {
    try {
      const status = await step.do(`incoming-promotion-${segment}-${operation}`, STEP_CONFIG, async () => {
        const next = await resume(env, input.uploadId);
        // Never cache a successful durable step that only reports a transient
        // failure and did not advance the journal. Throwing lets the Workflow
        // retry this exact operation rather than persisting a no-op result.
        if ((next.state === "pending" || next.state === "copying") && next.errorCode) {
          throw new Error(next.errorCode);
        }
        return next;
      });
      lastStatus = status;
      if (terminal(status)) return { kind: "terminal", status };
      transientCount = 0;
    } catch (error) {
      transientCount += 1;
      // Workflow retries may serialize/rethrow an ordinary Error, losing any
      // subclass fields. Do not infer a persisted state from that error; the
      // continuation dispatcher must read the journal before scheduling again.
      lastStatus = null;
      if (transientCount >= INCOMING_PROMOTION_DRIVER_MAX_TRANSIENTS) {
        return { kind: "continue", continuation: { uploadId: input.uploadId, segment: segment + 1, reason: "transient_retry_exhausted" }, lastStatus };
      }
      // This is a bounded durable wait. The next differently named step makes
      // a fresh resume call after exhausted in-step retries or a runtime error.
      await step.sleep(`incoming-promotion-backoff-${segment}-${operation}`, `${10 * 2 ** (transientCount - 1)} seconds`);
    }
  }
  return { kind: "continue", continuation: { uploadId: input.uploadId, segment: segment + 1, reason: "operation_budget" }, lastStatus };
}
