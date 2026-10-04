import { expect, test, type Page } from '@playwright/test';

const folderId = 'ond1_boundary_folder';
const fileId = 'ond1_boundary_file';
const home = { resourceMode: 'operations_home', homes: [{
  authorityId: '12345678-1234-4123-8123-123456789abc', workspaceId: 'boundary-workspace',
  ownershipEpoch: 1, grantRevision: 1, services: [],
}] };
const file = { id: fileId, name: 'report.pdf', size: 42, uploadedAt: '2026-09-30 12:00:00',
  contentType: 'application/pdf', kind: 'pdf', thumbnailPath: null,
  previewPath: `/api/client/operations/data/files/${fileId}/preview`,
  downloadPath: `/api/client/operations/data/files/${fileId}/download`,
};
const listing = { resourceMode: 'operations_native_delivery', files: [file], folders: [],
  breadcrumbs: [{ id: folderId, name: 'Shared project' }], folderId, prefix: '', cursor: null,
};

async function openSharedFolder(page: Page, folderResponse: unknown) {
  await page.route('**/api/client/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/client/v2/operations/home') return route.fulfill({ json: home });
    if (path === '/api/client/session') return route.fulfill({ status: 401, json: { error: 'Sign in required' } });
    if (path === '/api/client/operations/data/deliveries') return route.fulfill({ json: {
      resourceMode: 'operations_native_delivery', items: [{ id: folderId, displayName: 'Shared project' }],
      page: { nextCursor: null },
    } });
    if (path === `/api/client/operations/data/folders/${folderId}`) return route.fulfill({ json: folderResponse });
    return route.fulfill({ status: 404, json: { error: 'Unavailable' } });
  });
  await page.goto('/portal');
  const browser = page.getByRole('region', { name: 'Shared deliveries' });
  await browser.getByRole('button', { name: 'Browse shared deliveries' }).click();
  await browser.getByRole('button', { name: /Shared project/ }).click();
  return browser;
}

for (const [name, invalidListing] of [
  ['foreign action', { ...listing, files: [{ ...file, previewPath: 'https://foreign.invalid/private' }] }],
  ['raw storage prefix', { ...listing, prefix: 'private/internal/' }],
  ['different folder', { ...listing, folderId: 'ond1_other_folder' }],
] as const) {
  test(`native data rejects ${name} before showing private labels or actions`, async ({ page }) => {
    const browser = await openSharedFolder(page, invalidListing);
    await expect(browser.getByRole('alert')).toContainText('temporarily unavailable');
    await expect(browser.getByText('report.pdf', { exact: true })).toHaveCount(0);
    await expect(browser.getByRole('link')).toHaveCount(0);
  });
}

test('bounded long filenames remain contained and actions stay usable on desktop and mobile', async ({ page }) => {
  const filename = `${'Very-long-file-name-'.repeat(24)}.pdf`;
  const browser = await openSharedFolder(page, { ...listing, files: [{ ...file, name: filename }] });
  await expect(browser.getByText(filename, { exact: true })).toBeVisible();
  await expect(browser.getByRole('link', { name: 'Preview' })).toBeVisible();
  await expect(browser.getByRole('link', { name: 'Download' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
