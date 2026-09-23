import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ClientOnboardingRecipientBinding, ClientOnboardingRecipientSessionRequestV1,
  ClientOnboardingRecipientSessionResultV1, ClientOnboardingRecipientStatusRequestV1,
  ClientOnboardingRecipientStatusResultV1, ClientOnboardingRecipientSubmitRequestV1,
  ClientOnboardingRecipientSubmitResultV1,
} from "@ltds/shared";
import type { Env } from "./types";

const unavailable = Object.freeze({ ok: false as const, protocolVersion: 1 as const, code: "unavailable" as const });

/** Private named entrypoint only. It is not mounted on the Operations fetch route. */
export class ClientOnboardingRecipientBridge extends WorkerEntrypoint<Env> implements ClientOnboardingRecipientBinding {
  session(_request: ClientOnboardingRecipientSessionRequestV1): Promise<ClientOnboardingRecipientSessionResultV1> { return Promise.resolve(unavailable); }
  submit(_request: ClientOnboardingRecipientSubmitRequestV1): Promise<ClientOnboardingRecipientSubmitResultV1> { return Promise.resolve(unavailable); }
  status(_request: ClientOnboardingRecipientStatusRequestV1): Promise<ClientOnboardingRecipientStatusResultV1> { return Promise.resolve(unavailable); }
}
