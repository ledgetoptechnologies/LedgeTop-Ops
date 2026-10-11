import { describe, expect, it } from "vitest";
import { exactNativeStagingConfiguration, exactNativeBillingStagingConfiguration } from "../src/worker/staging-native-authority-policy";

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
  it("keeps the scoped staff-delegation surface behind the same exact default-off billing gate", () => {
    for (const path of [
      "/api/native-client-portal/operations-billing-permissions/session",
      "/administration/client-portal/operations-billing-permissions",
    ]) {
      const request = new Request(`https://ops-staging.ledgetopdroneservices.com${path}`);
      expect(exactNativeBillingStagingConfiguration(request, exact)).toBe(false);
      expect(exactNativeBillingStagingConfiguration(request,
        { ...exact, OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "true" })).toBe(true);
      expect(exactNativeBillingStagingConfiguration(request,
        { ...exact, OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "true", ENVIRONMENT: "production" })).toBe(false);
    }
  });
  it("keeps billing management separately default-off and staging-only", () => {
    const request = new Request("https://ops-staging.ledgetopdroneservices.com/api/native-client-portal/operations-billing-authority/session");
    expect(exactNativeBillingStagingConfiguration(request, exact)).toBe(false);
    const enabled = { ...exact, OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "true" };
    expect(exactNativeBillingStagingConfiguration(request, enabled)).toBe(true);
    for (const override of [
      { OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "false" },
      { OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "TRUE" },
      { ENVIRONMENT: "production" },
      { PUBLIC_BASE_URL: "https://ops.ledgetopdroneservices.com" },
      { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: undefined },
    ]) expect(exactNativeBillingStagingConfiguration(request, { ...enabled, ...override })).toBe(false);
    expect(exactNativeBillingStagingConfiguration(new Request(
      "https://ops.ledgetopdroneservices.com/api/native-client-portal/operations-billing-authority/session",
    ), enabled)).toBe(false);
  });
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
