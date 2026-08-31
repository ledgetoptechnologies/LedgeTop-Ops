import { describe, expect, it, vi } from "vitest";
import { applyProjectionEvent } from "../src/projection";
import type { Env, ProjectionEvent } from "../src/types";

describe("Project Alpha tombstone consumer gate",()=>{
  it("rejects schema v2 before a lease, receipt, or projection database write",async()=>{
    const prepare=vi.fn(()=>{throw new Error("database-touched");});
    const env={OPS_DB:{prepare} as unknown as D1Database} as Env;
    const event:ProjectionEvent={event_id:"8db76af1-d6c8-41b3-a717-6517a8f50509",
      event_type:"projection.changed",occurred_at:"2026-08-30T19:00:00Z",
      schema_version:2,application_key:"ltds_ops",projection:{entity_type:"client",
        entity_id:"70",action:"tombstone",source_updated_at:"2026-08-30T18:59:00Z",data:{}}};
    await expect(applyProjectionEvent(env,event,"a".repeat(64)))
      .rejects.toThrow("projection-tombstone-reconciliation-not-enabled");
    expect(prepare).not.toHaveBeenCalled();
  });
});
