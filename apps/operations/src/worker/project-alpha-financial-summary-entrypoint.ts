import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProjectAlphaFinancialSummaryRequestV1, ProjectAlphaFinancialSummaryResultV1 } from "@ltds/shared";
import type { Env } from "./types";
import { readProjectAlphaFinancialSummary } from "./project-alpha-financial-summary";

/** Private Client-to-Operations RPC. PA credentials remain in Operations and
 * are never bound to the browser-facing Client Worker. */
export class ProjectAlphaFinancialSummary extends WorkerEntrypoint<Env> {
  readProjectAlphaFinancialSummary(input: ProjectAlphaFinancialSummaryRequestV1): Promise<ProjectAlphaFinancialSummaryResultV1> {
    return readProjectAlphaFinancialSummary(this.env, input);
  }
}
