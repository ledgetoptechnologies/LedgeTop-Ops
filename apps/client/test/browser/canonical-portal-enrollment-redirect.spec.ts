import { expect, test } from "@playwright/test";
import { legacyClientRedirectLocation } from "../../src/worker/origin-policy";

const intentId = "00000000-0000-4000-8000-000000000001", opaqueToken = "ab".repeat(32);
const path = `/portal/operations-recipient-enrollment/${intentId}`;

for (const environment of ["production", "staging"] as const) {
  test(`${environment}: canonical consent consumes the retained historical intent fragment before API requests`, async ({ page }) => {
    const suffix = environment === "staging" ? "-staging" : "";
    const old = `https://client${suffix}.ledgetopdroneservices.com`;
    const portal = `https://portal${suffix}.ledgetopdroneservices.com`;
    const publicOrigin = environment === "staging" ? "https://delivery-staging.ledgetopdroneservices.com" : portal;
    const configuration = { ENVIRONMENT: environment, EXPECTED_HOST: new URL(publicOrigin).hostname,
      PUBLIC_BASE_URL: publicOrigin, PUBLIC_SHARE_ORIGIN: publicOrigin, CLIENT_PORTAL_ORIGIN: portal,
      CLIENT_PORTAL_ORIGINS: portal, CLIENT_PORTAL_RETIRED_ORIGINS: old,
      ...(environment === "production" ? { LEGACY_CLIENT_ORIGINS: old } : {}) };
    const requests: Array<{ pathname: string; body: unknown; visibleUrl: string }> = [];
    await page.route(`${portal}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/client/operations/recipient-enrollment/")) {
        requests.push({ pathname: url.pathname, body: route.request().postDataJSON(), visibleUrl: page.url() });
        if (url.pathname.endsWith("/session")) return route.fulfill({ json: { csrfToken: `123456.${"cd".repeat(32)}` } });
        if (url.pathname.endsWith("/inspect")) return route.fulfill({ json: { intentId, revision: 1, state: "issued",
          target: { targetId: "11111111-1111-4111-8111-111111111111", targetRevision: 2, clientRecordId: "retained-client", displayLabel: "Existing client" },
          expiresAt: new Date(Date.now() + 60_000).toISOString() } });
        throw new Error("Read-only browser inspection must not redeem enrollment");
      }
      const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` });
      return route.fulfill({ response });
    });
    try {
      // Worker redirects cannot see fragments. Verify its exact destination,
      // then exercise the canonical page with the retained browser fragment.
      // The deployed Access login/redirect chain remains a live release gate.
      const location = legacyClientRedirectLocation(`${old}${path}`, configuration);
      expect(location).toBe(`${portal}${path}`);
      await page.goto(`${location}#${opaqueToken}`);
      await expect(page.getByText("Existing client", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(`${portal}${path}`);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.body).toEqual({ intentId, opaqueToken });
      expect(requests.every(request => !request.visibleUrl.includes(opaqueToken) && !request.pathname.includes(opaqueToken))).toBe(true);
    } finally { await page.unrouteAll({ behavior: "wait" }); }
  });
}
