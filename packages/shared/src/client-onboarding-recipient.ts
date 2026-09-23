/** Versioned private Client -> Operations recipient bridge contract. */
export interface ClientOnboardingRecipientSessionRequestV1 { protocolVersion: 1; }
export interface ClientOnboardingRecipientSubmitRequestV1 {
  protocolVersion: 1; invitationId: string; invitationSecret: string; submissionId: string; fields: Record<string, unknown>;
}
export interface ClientOnboardingRecipientStatusRequestV1 { protocolVersion: 1; submissionId: string; }
export interface ClientOnboardingRecipientUnavailableV1 { ok: false; protocolVersion: 1; code: "unavailable"; }
export type ClientOnboardingRecipientSessionResultV1 = ClientOnboardingRecipientUnavailableV1;
export type ClientOnboardingRecipientSubmitResultV1 = ClientOnboardingRecipientUnavailableV1;
export type ClientOnboardingRecipientStatusResultV1 = ClientOnboardingRecipientUnavailableV1;
export interface ClientOnboardingRecipientBinding {
  session(request: ClientOnboardingRecipientSessionRequestV1): Promise<ClientOnboardingRecipientSessionResultV1>;
  submit(request: ClientOnboardingRecipientSubmitRequestV1): Promise<ClientOnboardingRecipientSubmitResultV1>;
  status(request: ClientOnboardingRecipientStatusRequestV1): Promise<ClientOnboardingRecipientStatusResultV1>;
}
