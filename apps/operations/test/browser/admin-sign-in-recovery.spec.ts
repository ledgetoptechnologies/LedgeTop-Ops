import { expect, test } from '@playwright/test';

const paths = [
  '/administration/client-onboarding',
  '/administration/client-portal/recipients',
  '/administration/client-portal/operations-recipients',
  '/administration/client-portal/operations-delivery-authority',
  '/administration/client-portal/operations-billing-authority',
  '/administration/client-portal/operations-billing-permissions',
  '/administration/client-portal/operations-workspaces',
];

for (const status of [401, 403, 503]) for (const path of paths) {
  test(`${path} session ${status} offers safe sign-in and retry without a mutation`, async ({ page }) => {
    const methods: string[] = [];
    let reads = 0;
    await page.route('**/api/**', route => {
      methods.push(route.request().method()); reads++;
      return route.fulfill({ status, json: { error: 'Session unavailable' } });
    });
    await page.route('**/cdn-cgi/access/get-identity', route => route.fulfill({ status: 401, body: '' }));
    await page.goto(path);
    const signIn = page.getByRole('link', { name: 'Sign in with a different email' });
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute('href', '/cdn-cgi/access/logout');
    await expect(page.locator('form')).toHaveCount(0);
    const beforeRetry = reads;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(signIn).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(beforeRetry);
    expect(methods.every(method => method === 'GET')).toBe(true);
    await expect(page.getByText('Still stuck? Ask your Ledge Top contact or administrator for help.')).toBeVisible();
  });
}
