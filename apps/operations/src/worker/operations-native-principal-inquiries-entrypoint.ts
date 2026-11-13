import { WorkerEntrypoint } from "cloudflare:workers";
import { listOpsPrincipalInquiries, submitOpsPrincipalInquiry } from "./operations-native-principal-inquiries";
import type { Env } from "./types";

/** Private Client Worker service ingress; methods accept only canonical JSON envelopes. */
export class OperationsNativePrincipalInquiryIngress extends WorkerEntrypoint<Env>{
 listNativePrincipalInquiries(raw:string):Promise<string>{return listOpsPrincipalInquiries(this.env,raw);}
 submitNativePrincipalInquiry(raw:string):Promise<string>{return submitOpsPrincipalInquiry(this.env,raw);}
}
