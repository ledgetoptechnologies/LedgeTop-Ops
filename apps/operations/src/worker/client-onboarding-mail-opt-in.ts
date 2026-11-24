import { assertInviteMailKeyringsDisjoint, snapshotClientOnboardingKeyring } from "./client-onboarding-handoff";
import { snapshotInviteMailKeyring } from "./client-onboarding-invite-mail-crypto";
import { parseInviteDestinationBindings } from "./client-onboarding-invite-destinations";
import { dispatchInviteMailOnce } from "./client-onboarding-invite-mail-dispatch";
import { handleClientOnboardingStaffHttp, type ClientOnboardingStaffHttpDependencies } from "./client-onboarding-staff-http";

type DispatchOptions = Parameters<typeof dispatchInviteMailOnce>[2];
type StaffDependencies = Omit<ClientOnboardingStaffHttpDependencies, "inviteMailIssuanceEnabled" | "inviteMailKeysJson">;
export type ClientOnboardingMailOptIn = Readonly<{
  enabled?: string;
  keysJson?: string;
  send?: DispatchOptions["send"];
}>;

const encoder = new TextEncoder();

function boundedKeyringJson(raw: string | undefined): unknown {
  if (typeof raw !== "string" || raw.length > 4_096 || encoder.encode(raw).byteLength > 4_096)
    throw Error("client_onboarding_keyring_unavailable");
  return JSON.parse(raw);
}

function dispatcherOptions(dependencies: StaffDependencies, optIn?: ClientOnboardingMailOptIn): DispatchOptions | null {
  const send = optIn?.send;
  const config = dependencies.inviteDestinationBindingsJson;
  if (optIn?.enabled !== "true" || typeof send !== "function" || typeof config !== "string" || !parseInviteDestinationBindings(config).length)
    return null;
  try {
    const mailKeyring = snapshotInviteMailKeyring(boundedKeyringJson(optIn.keysJson));
    const handoff = snapshotClientOnboardingKeyring(boundedKeyringJson(dependencies.handoffKeyringJson));
    assertInviteMailKeyringsDisjoint(handoff, mailKeyring);
    return Object.freeze({ send, destinationBindingsJson: config, mailKeyring });
  } catch {
    return null;
  }
}

/** The caller owns delivery admission and supplies the sender explicitly.
 * The staff handler still verifies origin, authentication, CSRF, destination
 * authority and schema. Dispatch is a private callable for the same database. */
export function createClientOnboardingMailOptIn(dependencies: StaffDependencies, optIn?: ClientOnboardingMailOptIn) {
  const base = { ...dependencies, configuration: { ...dependencies.configuration } };
  const requested = optIn ? { ...optIn } : undefined;
  const options = dispatcherOptions(base, requested);
  const { database } = base;
  const staff: ClientOnboardingStaffHttpDependencies = {
    ...base,
    inviteMailIssuanceEnabled: options ? "true" : undefined,
    inviteMailKeysJson: options ? requested?.keysJson : undefined,
  };
  return Object.freeze({
    fetch: (request: Request) => handleClientOnboardingStaffHttp(request, staff),
    dispatchCommand: (commandId: string) => options
      ? dispatchInviteMailOnce(database, commandId, options)
      : Promise.resolve("not_ready" as const),
  });
}
