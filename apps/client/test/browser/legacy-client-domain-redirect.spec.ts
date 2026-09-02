import { expect, test } from "@playwright/test";

test("legacy public links retain their path, query, and fragment on the canonical portal host", async ({ page }) => {
  await page.route("https://client.ledgetopdroneservices.com/**", async route => {
    const requestUrl = new URL(route.request().url());
    const builtApp = await page.request.get(`http://127.0.0.1:4173${requestUrl.pathname}${requestUrl.search}`);
    await route.fulfill({ response: builtApp });
  });
  await page.route("https://portal.ledgetopdroneservices.com/**", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Canonical portal</title><main id='fragment'></main><script>document.querySelector('#fragment').textContent=location.hash</script>",
  }));

  await page.goto("https://client.ledgetopdroneservices.com/s/public-id?folder=edited#private-fragment-secret");

  expect(page.url()).toBe("https://portal.ledgetopdroneservices.com/s/public-id?folder=edited#private-fragment-secret");
  await expect(page.locator("#fragment")).toHaveText("#private-fragment-secret");
});
