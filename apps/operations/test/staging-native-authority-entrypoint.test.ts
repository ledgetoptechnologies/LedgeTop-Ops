import { describe, expect, it } from "vitest";
import { exactNativeStagingConfiguration } from "../src/worker/staging-native-authority-policy";

type NativeEnv = Parameters<typeof exactNativeStagingConfiguration>[1];
const exact = {
  ENVIRONMENT: "staging",
  EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
  PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true",
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {},
  OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY: {},
  OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true",
} as NativeEnv;

describe("staging native authority entrypoint", () => {
  it("admits only the exact HTTPS Operations staging configuration", () => {
    const request = new Request("https://ops-staging.ledgetopdroneservices.com/api/native-client-portal/operations-delivery-authority/session");
    expect(exactNativeStagingConfiguration(request, exact)).toBe(true);
    for (const override of [
      { ENVIRONMENT: "production" },
      { EXPECTED_HOST: "ops.ledgetopdroneservices.com" },
      { CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "false" },
      { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: undefined },
      { OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED: "false" },
      { OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY: undefined },
      { OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "false" },
    ]) expect(exactNativeStagingConfiguration(request, { ...exact, ...override })).toBe(false);
    expect(exactNativeStagingConfiguration(new Request(
      "https://ops.ledgetopdroneservices.com/api/native-client-portal/operations-delivery-authority/session",
    ), exact)).toBe(false);
  });
});
