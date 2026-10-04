import { WorkerEntrypoint } from "cloudflare:workers";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus }
  from "./operations-portal-native-recipient-authority";
import type { Env } from "./types";

export class OperationsPortalNativeRecipientAuthorityIngress extends WorkerEntrypoint<Env> {
  applyNativeAuthority(input: unknown): Promise<string> {
    return applyOperationsPortalNativeRecipientAuthority(this.env, input);
  }
  getNativeAuthorityStatus(input: unknown): Promise<string> {
    return readOperationsPortalNativeRecipientAuthorityStatus(this.env, input);
  }
}
