/** Strict field contract only; parsing does not grant access or link identities. */
export const CLIENT_ONBOARDING_LIMITS = Object.freeze({
  name: 150, email: 255, phone: 50,
  organizationName: 150, organizationEmail: 255, organizationPhone: 50,
  addressLine1: 255, addressLine2: 255, city: 100, state: 100,
  postalCode: 32, country: 100,
});
export type ClientOnboardingFields = Readonly<{
  clientType: "consumer" | "business";
  name: string; email: string; phone: string;
  organizationName: string; organizationEmail: string; organizationPhone: string;
  addressLine1: string; addressLine2: string; city: string; state: string;
  postalCode: string; country: string;
}>;
const KEYS = ["clientType", ...Object.keys(CLIENT_ONBOARDING_LIMITS)];
const COMPANY = new Set(["organizationName", "organizationEmail", "organizationPhone"]);
const CODEPOINT_FIELDS = new Set(["state", "postalCode", "country"]);
function validEmail(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain || local.length > 64 || local.startsWith(".") || local.endsWith(".")
    || local.includes("..") || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every(label => label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}
export function parseClientOnboardingFields(input: unknown): ClientOnboardingFields {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== KEYS.length || keys.some(key => typeof key !== "string" || !KEYS.includes(key))) throw Error();
    const values: Record<string, string> = {};
    for (const key of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") throw Error();
      values[key] = descriptor.value;
    }
    const clientType = values.clientType;
    if (clientType !== "consumer" && clientType !== "business") throw Error();
    for (const [key, maximum] of Object.entries(CLIENT_ONBOARDING_LIMITS)) {
      if (clientType === "consumer" && COMPANY.has(key)) { values[key] = ""; continue; }
      const raw = values[key]!;
      const effectiveMaximum = clientType === "consumer" && key === "state" ? 2
        : clientType === "consumer" && key === "postalCode" ? 20 : maximum;
      if ((CODEPOINT_FIELDS.has(key) ? Array.from(raw).length : raw.length) > effectiveMaximum || /\p{C}/u.test(raw)) throw Error();
      values[key] = raw.trim();
    }
    values.email = values.email!.toLowerCase();
    values.organizationEmail = values.organizationEmail!.toLowerCase();
    if (!values.name || !validEmail(values.email!) || (clientType === "business" && !values.organizationName)
      || (values.organizationEmail && !validEmail(values.organizationEmail))) throw Error();
    return Object.freeze({ clientType, name: values.name!, email: values.email!, phone: values.phone!,
      organizationName: values.organizationName!, organizationEmail: values.organizationEmail!,
      organizationPhone: values.organizationPhone!, addressLine1: values.addressLine1!,
      addressLine2: values.addressLine2!, city: values.city!, state: values.state!,
      postalCode: values.postalCode!, country: values.country || "US" });
  } catch { throw new Error("client_onboarding_fields_invalid"); }
}
