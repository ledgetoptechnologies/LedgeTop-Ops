import { WorkerEntrypoint } from "cloudflare:workers";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus }
  from "./operations-portal-native-recipient-authority";
import { applyOperationsPortalNativeInquiryCapability, closeOperationsPortalNativeInquiryCapability,
  readOperationsPortalNativeInquiryCapabilityStatus } from "./operations-portal-native-inquiry-capability";
import type { Env } from "./types";

export class OperationsPortalNativeRecipientAuthorityIngress extends WorkerEntrypoint<Env> {
  applyNativeAuthority(input: unknown): Promise<string> {
    return applyOperationsPortalNativeRecipientAuthority(this.env, input);
  }
  getNativeAuthorityStatus(input: unknown): Promise<string> {
    return readOperationsPortalNativeRecipientAuthorityStatus(this.env, input);
  }
  applyNativeInquiryCapability(input: unknown): Promise<string> {
    return applyOperationsPortalNativeInquiryCapability(this.env, input);
  }
  closeNativeInquiryCapability(input: unknown): Promise<string> {
    return closeOperationsPortalNativeInquiryCapability(this.env, input);
  }
  getNativeInquiryCapabilityStatus(input: unknown): Promise<string> {
    return readOperationsPortalNativeInquiryCapabilityStatus(this.env, input);
  }
}
