import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { incomingPromotionInstanceId, type IncomingPromotionSegment } from "./incoming-rclone-dispatch";
import { enqueueIncomingRcloneSegment, drainIncomingRcloneOutbox } from "./incoming-rclone-outbox";
import { runIncomingRclonePromotionDriver } from "./incoming-rclone-driver";
import { markIncomingRclonePromotionExhausted } from "./incoming-rclone-promotion";
import type { IncomingEnv } from "./incoming";

export class IncomingRclonePromotionWorkflow extends WorkflowEntrypoint<IncomingEnv, IncomingPromotionSegment> {
  async run(event: Readonly<WorkflowEvent<IncomingPromotionSegment>>, step: WorkflowStep) {
    const enabled = await step.do("check-release-gate", async () => this.env.INCOMING_RCLONE_PROMOTION_ENABLED === "true");
    if (!enabled) return { state: "disabled" };
    await step.do("validate-segment", async () => incomingPromotionInstanceId(event.payload));
    const result = await runIncomingRclonePromotionDriver(this.env, event.payload, step);
    if (result.kind === "terminal") return { state: result.status.state, uploadId: event.payload.uploadId };

    const consecutiveFailures = result.continuation.reason === "transient_retry_exhausted"
      ? event.payload.consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= 3 || result.continuation.segment > 2000) {
      await step.do("record-exhausted-retries", async () => {
        // Never undo an attempted publication or a confirmed ready object.
        await markIncomingRclonePromotionExhausted(this.env, event.payload.uploadId);
        return { recorded: true };
      });
      return { state: "needs_attention", uploadId: event.payload.uploadId };
    }
    if (consecutiveFailures > 0) await step.sleep("between-segment-retry", "5 minutes");
    const continuation: IncomingPromotionSegment = {
      uploadId: event.payload.uploadId, segment: result.continuation.segment, consecutiveFailures,
    };
    await step.do("persist-next-segment", {
      retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
    }, async () => enqueueIncomingRcloneSegment(this.env, continuation));
    // Persist first: scheduled recovery can dispatch even if this step fails.
    await step.do("drain-next-segment", async () => drainIncomingRcloneOutbox(this.env));
    return { state: "continuation_queued", uploadId: event.payload.uploadId, segment: continuation.segment };
  }
}
