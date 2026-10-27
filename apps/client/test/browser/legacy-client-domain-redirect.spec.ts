import { expect, test } from "@playwright/test";

for (const host of ["client.ledgetopdroneservices.com", "portal.ledgetopdroneservices.com"]) {
  for (const root of ["s", "client-share"]) {
    test(`${host}/${root} keeps the fragment until reaching canonical delivery, even with old cookies`, async ({ page, context }) => {
      await context.addCookies([{ name: "legacy_session_marker", value: "synthetic-test-only", url: `https://${host}` }]);
      const legacyNavigations: string[] = [];
      const deliveryRequests: Array<{ url: string; cookie: string | undefined; authorization: string | undefined }> = [];
      await page.route(`https://${host}/**`, async route => {
        const request = route.request();
        if (request.isNavigationRequest()) legacyNavigations.push(request.headers().cookie || "");
        const requestUrl = new URL(request.url());
        const builtApp = await page.request.get(`http://127.0.0.1:4173${requestUrl.pathname}${requestUrl.search}`);
        await route.fulfill({ response: builtApp });
      });
      await page.route("https://delivery.ledgetop.app/**", route => {
        const request = route.request();
        deliveryRequests.push({ url: request.url(), cookie: request.headers().cookie, authorization: request.headers().authorization });
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>Canonical delivery</title><main id='fragment'></main><script>document.querySelector('#fragment').textContent=location.hash</script>",
        });
      });

      await page.goto(`https://${host}/${root}/public-id?folder=edited#private-fragment-secret`);

      await expect(page).toHaveURL(`https://delivery.ledgetop.app/${root}/public-id?folder=edited#private-fragment-secret`);
      await expect(page.locator("#fragment")).toHaveText("#private-fragment-secret");
      expect(legacyNavigations).toEqual(["legacy_session_marker=synthetic-test-only"]);
      expect(deliveryRequests).toEqual([{ url: `https://delivery.ledgetop.app/${root}/public-id?folder=edited`, cookie: undefined, authorization: undefined }]);
    });
  }
}
