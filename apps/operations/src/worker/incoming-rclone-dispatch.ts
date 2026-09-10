export type IncomingPromotionSegment = {
  uploadId: string;
  segment: number;
  consecutiveFailures: number;
};

type Binding = Pick<Workflow<IncomingPromotionSegment>, "create" | "get">;

/** Stable, bounded instance IDs; caller supplies only an authorized upload ID. */
export async function incomingPromotionInstanceId(input: IncomingPromotionSegment): Promise<string> {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(input.uploadId)
    || !Number.isSafeInteger(input.segment) || input.segment < 0 || input.segment > 2000
    || !Number.isSafeInteger(input.consecutiveFailures) || input.consecutiveFailures < 0 || input.consecutiveFailures > 3) {
    throw new Error("incoming_promotion_invalid_segment");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.uploadId));
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  return `incoming-${hash}-${input.segment}`;
}

/**
 * Recover an ambiguous create only by reading the exact deterministic instance.
 * An errored/terminated instance needs deliberate recovery; it is not queued.
 * This helper never restarts jobs, modifies data, or infers local pickup.
 */
export async function dispatchIncomingRcloneSegment(binding: Binding, input: IncomingPromotionSegment): Promise<{ id: string; reused: boolean }> {
  const id = await incomingPromotionInstanceId(input);
  try {
    await binding.create({ id, params: input });
    return { id, reused: false };
  } catch {
    try {
      const existing = await binding.get(id);
      const result = await existing.status();
      if (["queued", "running", "waiting", "complete"].includes(result.status)) return { id, reused: true };
    } catch {
      // A missing instance or failed observation is not proof of dispatch.
    }
    throw new Error("incoming_promotion_dispatch_unconfirmed");
  }
}
