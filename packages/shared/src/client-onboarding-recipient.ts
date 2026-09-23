/** Versioned private Client -> Operations recipient bridge contract. */
export interface ClientOnboardingRecipientBearerRequestV1 {
  protocolVersion: 1;
  invitationId: string;
  invitationSecret: string;
}
export interface ClientOnboardingRecipientSessionRequestV1 extends ClientOnboardingRecipientBearerRequestV1 {}
export interface ClientOnboardingRecipientSubmitRequestV1 {
  protocolVersion: 1; invitationId: string; invitationSecret: string; submissionId: string; fields: Record<string, unknown>;
}
export interface ClientOnboardingRecipientStatusRequestV1 extends ClientOnboardingRecipientBearerRequestV1 {
  submissionId: string;
}
export interface ClientOnboardingRecipientUnavailableV1 { ok: false; protocolVersion: 1; code: "unavailable"; }
export interface ClientOnboardingRecipientPendingV1 { ok: true; protocolVersion: 1; state: "pending"; }
export interface ClientOnboardingRecipientSubmittedV1 {
  ok: true; protocolVersion: 1; state: "submitted"; submissionId: string;
}
export type ClientOnboardingRecipientSessionResultV1 = ClientOnboardingRecipientPendingV1
  | ClientOnboardingRecipientSubmittedV1 | ClientOnboardingRecipientUnavailableV1;
export type ClientOnboardingRecipientSubmitResultV1 = ClientOnboardingRecipientSubmittedV1
  | ClientOnboardingRecipientUnavailableV1;
export type ClientOnboardingRecipientStatusResultV1 = ClientOnboardingRecipientPendingV1
  | ClientOnboardingRecipientSubmittedV1 | ClientOnboardingRecipientUnavailableV1;
export interface ClientOnboardingRecipientBinding {
  session(request: ClientOnboardingRecipientSessionRequestV1): Promise<ClientOnboardingRecipientSessionResultV1>;
  submit(request: ClientOnboardingRecipientSubmitRequestV1): Promise<ClientOnboardingRecipientSubmitResultV1>;
  status(request: ClientOnboardingRecipientStatusRequestV1): Promise<ClientOnboardingRecipientStatusResultV1>;
}
