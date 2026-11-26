import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  AUTOMATION_AUTHOR, checkAll, exitCodeFor, formatReport, issueMarker, issuesFor, releaseVersion, syncIssues,
} from '../scripts/check-parcel-releases.mjs';

const require = createRequire(import.meta.url);
const { WISCONSIN } = require('../server/parcelSources.js');

const SERVICE = WISCONSIN.layerUrl.replace(/\/0$/, '');
const DIRECTORY = WISCONSIN.discovery.servicesDirectory;
const now = () => new Date('2027-07-01T14:17:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const v12Layer = { type: 'Feature Layer', geometryType: 'esriGeometryPolygon', name: 'V1200_WisconsinParcels_2026',
  copyrightText: 'Product of the Version 12 Statewide Parcel Map Database Project (V12).',
  extent: { spatialReference: { wkid: 102100, latestWkid: 3857 } }, fields: [{ name: 'OBJECTID' }, { name: 'PARCELID' }, { name: 'OWNERNME1' }, { name: 'ASSDACRES' }],
  editingInfo: { dataLastEditDate: Date.UTC(2026, 5, 30, 21, 21, 29) } };
const v12Item = { title: 'Wisconsin Statewide Parcels DB', name: 'Wisconsin_Statewide_Parcels_DB', url: SERVICE.replace('/ArcGIS/', '/arcgis/'),
  snippet: 'Wisconsin Statewide Parcel Layer Version 12.0.0 (V12.0.0)', tags: ['V12 Parcels', 'V11 Parcels', 'V2 Parcels', 'Parcels'] };
const directoryWith = (...services) => ({ services: [{ name: '2015_Grants', type: 'FeatureServer', url: `${DIRECTORY}/2015_Grants/FeatureServer` }, ...services] });
const currentService = { name: 'Wisconsin_Statewide_Parcels_DB', type: 'FeatureServer', url: SERVICE };

// Routes a mocked fetch by URL; records every URL asked.
function mockFetch(routes) {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    const u = new URL(url);
    const key = u.origin + u.pathname;
    if (!(key in routes)) throw new Error(`unexpected request ${key}`);
    const route = routes[key];
    return typeof route === 'function' ? route(u) : json(route);
  };
  return { fetchImpl, seen };
}

const baseRoutes = (overrides = {}) => ({
  [WISCONSIN.layerUrl]: v12Layer,
  [`${WISCONSIN.discovery.portalUrl}/sharing/rest/search`]: { total: 1, results: [v12Item] },
  [DIRECTORY]: directoryWith(currentService),
  [SERVICE]: { layers: [{ id: 0, name: 'V1200_WisconsinParcels_2026' }] },
  ...overrides,
});

test('release numbers are read from layer names, tags, summaries and credits', () => {
  const p = WISCONSIN.discovery.versionPatterns;
  assert.equal(releaseVersion(['V1200_WisconsinParcels_2026'], p), 12);
  assert.equal(releaseVersion(['V1300_WisconsinParcels_2027'], p), 13);
  assert.equal(releaseVersion([['V12 Parcels', 'V11 Parcels', 'V9 Parcels']], p), 12, 'cumulative tags: the highest');
  assert.equal(releaseVersion(['Layer Version 13.0.0 (V13.0.0)'], p), 13);
  assert.equal(releaseVersion(['Product of the Version 12 Statewide Parcel Map'], p), 12);
  assert.equal(releaseVersion(['Wisconsin Statewide Parcels DB', null, 'https://doa.wi.gov/v1/x'], p), null);
});

test('check: configured layer up and no newer release', async () => {
  const { fetchImpl, seen } = mockFetch(baseRoutes());
  const report = await checkAll([WISCONSIN], { fetchImpl, now });
  const [r] = report.results;
  assert.equal(r.layer.up, true);
  assert.equal(r.layer.version, 12);
  assert.equal(r.newer, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(exitCodeFor(report), 0);
  assert.deepEqual(issuesFor(report), []);
  assert.equal(r.layer.dataUpdated, '2026-06-30');
  assert.match(formatReport(report), /OK: the configured layer answers \(V1200_WisconsinParcels_2026\)\.\n {2}Data last edited 2026-06-30 \(registry: 2026-06-30\)\.\n {2}No release newer than V12 found\./);
  const search = new URL(seen.find(url => url.includes('/sharing/rest/search')));
  assert.equal(search.searchParams.get('q'), 'orgid:n6uYoouQZW75n5WI AND type:"Feature Service" AND parcels', 'scoped to the publishing organisation');
  assert.ok(seen.every(url => url.startsWith('https://')), 'https only');
  assert.ok(!seen.some(url => url.includes('/2015_Grants/')), 'unrelated services are not opened');
});

test('check: newer layer data or a missing owner field is a warning, not an error', async () => {
  const later = { ...v12Layer, fields: [{ name: 'OBJECTID' }, { name: 'ASSDACRES' }], editingInfo: { dataLastEditDate: Date.UTC(2026, 9, 2) } };
  const { fetchImpl } = mockFetch(baseRoutes({ [WISCONSIN.layerUrl]: later }));
  const report = await checkAll([WISCONSIN], { fetchImpl, now });
  const [r] = report.results;
  assert.equal(r.layer.up, true);
  assert.equal(r.layer.dataUpdated, '2026-10-02');
  assert.ok(r.warnings.some(w => /no longer has owner field OWNERNME1/.test(w)), r.warnings.join('; '));
  assert.ok(r.warnings.some(w => /edited on 2026-10-02, after the registry's dataUpdated 2026-06-30/.test(w)), r.warnings.join('; '));
  assert.equal(exitCodeFor(report), 0);
});

test('check: a newer release published as a new service is reported, not an error', async () => {
  const v13Url = `${DIRECTORY}/Wisconsin_Statewide_Parcels_V13/FeatureServer`;
  const v13Item = { title: 'Wisconsin Statewide Parcels V13', name: 'Wisconsin_Statewide_Parcels_V13', url: v13Url, snippet: 'Version 13.0.0', tags: ['V13 Parcels'] };
  const { fetchImpl } = mockFetch(baseRoutes({
    [`${WISCONSIN.discovery.portalUrl}/sharing/rest/search`]: { results: [v13Item, v12Item, { title: 'Grant sites V40', tags: ['V40'] }] },
    [DIRECTORY]: directoryWith(currentService, { name: 'Wisconsin_Statewide_Parcels_V13', type: 'FeatureServer', url: v13Url }),
    [v13Url]: { layers: [{ id: 0, name: 'V1300_WisconsinParcels_2027' }] },
  }));
  const report = await checkAll([WISCONSIN], { fetchImpl, now });
  const [r] = report.results;
  assert.equal(r.layer.up, true);
  assert.equal(r.newer.version, 13, 'unrelated items that do not match the name pattern are ignored');
  assert.equal(r.newer.inPlace, false);
  assert.equal(exitCodeFor(report), 0, 'a newer release is not a failure');
  const issues = issuesFor(report);
  assert.deepEqual(issues.map(i => i.title), ['Parcel source update available: Wisconsin V13']);
  assert.match(issues[0].body, /still uses V12 \(2026\)/);
  assert.match(issues[0].body, /apps\/viewer\/server\/parcelSources\.js/);
  assert.match(formatReport(report), /NEWER RELEASE: V13/);
  assert.equal(WISCONSIN.layerUrl, `${SERVICE}/0`, 'the registry is never changed by the check');
});

test('check: a release replaced in place is reported against the configured layer', async () => {
  const { fetchImpl } = mockFetch(baseRoutes({
    [WISCONSIN.layerUrl]: { ...v12Layer, name: 'V1300_WisconsinParcels_2027', copyrightText: 'Version 13' },
    [`${WISCONSIN.discovery.portalUrl}/sharing/rest/search`]: { results: [] },
  }));
  const report = await checkAll([WISCONSIN], { fetchImpl, now });
  assert.equal(report.results[0].newer.version, 13);
  assert.equal(report.results[0].newer.inPlace, true);
  assert.match(formatReport(report), /configured layer now reports V13/);
  assert.equal(exitCodeFor(report), 0);
});

test('check: configured URL down fails the run and files a down issue', async () => {
  for (const layerRoute of [
    () => json({ error: 'gone' }, 404),
    () => json({ error: { code: 400, message: 'Invalid URL' } }),
    () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); },
    () => json({ ...v12Layer, fields: [{ name: 'OBJECTID_1' }] }),
  ]) {
    const { fetchImpl } = mockFetch(baseRoutes({ [WISCONSIN.layerUrl]: layerRoute }));
    const report = await checkAll([WISCONSIN], { fetchImpl, now });
    assert.equal(report.results[0].layer.up, false);
    assert.equal(exitCodeFor(report), 1);
    assert.deepEqual(issuesFor(report).map(i => i.title), ['Parcel source down: Wisconsin']);
    assert.match(formatReport(report), /DOWN: the configured layer does not answer: /);
  }
});

test('check: discovery outages are warnings, not failures', async () => {
  const { fetchImpl } = mockFetch(baseRoutes({
    [`${WISCONSIN.discovery.portalUrl}/sharing/rest/search`]: () => json({}, 503),
    [DIRECTORY]: () => json({}, 503),
  }));
  const report = await checkAll([WISCONSIN], { fetchImpl, now });
  assert.equal(exitCodeFor(report), 0);
  assert.equal(report.results[0].newer, null);
  assert.ok(report.results[0].warnings.includes('could not look for a newer release this time'));
  assert.deepEqual(issuesFor(report), []);
});

const BOT = { login: 'github-actions[bot]' };
const UPDATE = 'Parcel source update available: Wisconsin V13';
const DOWN = 'Parcel source down: Wisconsin';
const ownIssues = () => [
  { title: UPDATE, marker: issueMarker('wi-statewide-parcels', 'update'), body: `new body\n${issueMarker('wi-statewide-parcels', 'update')}` },
  { title: DOWN, marker: issueMarker('wi-statewide-parcels', 'down'), body: `down\n${issueMarker('wi-statewide-parcels', 'down')}` },
];
function githubMock(openIssues) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ method: options.method, url, body: options.body ? JSON.parse(options.body) : null, auth: options.headers.Authorization });
    if (options.method === 'GET') return json(openIssues);
    return json({ number: options.method === 'POST' ? 12 : Number(url.split('/').pop()) });
  };
  return { calls, fetchImpl };
}

test('issues: carry a hidden marker naming the source and finding', () => {
  const report = { checkedAt: 'x', results: [{ id: 'wi-statewide-parcels', region: 'Wisconsin', release: 'V12 (2026)', layerUrl: WISCONSIN.layerUrl,
    layer: { up: false, reason: 'HTTP 500' }, newer: { version: 13, title: 't', via: 'ArcGIS search', url: null, inPlace: false } }] };
  const issues = issuesFor(report);
  assert.deepEqual(issues.map(i => i.marker), ['<!-- parcel-source-release-check:wi-statewide-parcels:down -->', '<!-- parcel-source-release-check:wi-statewide-parcels:update -->']);
  for (const issue of issues) assert.ok(issue.body.endsWith(issue.marker));
  assert.equal(AUTOMATION_AUTHOR, 'github-actions[bot]');
});

test('issues: the automation updates its own open issue, never duplicating it', async () => {
  const { calls, fetchImpl } = githubMock([
    { number: 7, title: UPDATE, user: BOT, body: issueMarker('wi-statewide-parcels', 'update'), pull_request: { url: 'x' } },
    { number: 9, title: UPDATE, user: BOT, body: `old body\n${issueMarker('wi-statewide-parcels', 'update')}` },
  ]);
  const actions = await syncIssues(ownIssues(), { repo: 'example/repo', token: 't', fetchImpl });
  assert.deepEqual(actions, [
    { action: 'updated', number: 9, title: UPDATE },
    { action: 'opened', number: 12, title: DOWN },
  ]);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    'GET https://api.github.com/repos/example/repo/issues?state=open&per_page=100&page=1',
    'PATCH https://api.github.com/repos/example/repo/issues/9',
    'POST https://api.github.com/repos/example/repo/issues',
  ], 'the pull request with the same title is not treated as the issue');
  assert.deepEqual(calls[1].body, { body: ownIssues()[0].body });
  assert.deepEqual(calls[2].body, { title: DOWN, body: ownIssues()[1].body });
  assert.ok(calls.every(c => c.auth === 'Bearer t'));
  assert.deepEqual(await syncIssues([], { fetchImpl: () => assert.fail('no call') }), []);
  await assert.rejects(syncIssues(ownIssues(), { repo: 'example/repo', token: '', fetchImpl }), /GITHUB_TOKEN/);
});

test('issues: a same-title issue the automation does not own is never edited', async () => {
  const marker = issueMarker('wi-statewide-parcels', 'update');
  const { calls, fetchImpl } = githubMock([
    { number: 3, title: UPDATE, user: { login: 'operator' }, body: 'Notes an operator wrote by hand.' },
    { number: 4, title: UPDATE, user: { login: 'operator' }, body: `Copied the marker by hand.\n${marker}` },
    { number: 5, title: UPDATE, user: BOT, body: 'Bot issue without the marker.' },
    { number: 6, title: UPDATE, user: BOT, body: issueMarker('wi-statewide-parcels', 'down') },
    { number: 8, title: UPDATE, user: BOT, body: `own issue\n${marker}` },
  ]);
  const actions = await syncIssues([ownIssues()[0]], { repo: 'example/repo', token: 't', fetchImpl });
  assert.deepEqual(actions, [{ action: 'updated', number: 8, title: UPDATE }], 'only its own marked, bot-authored issue');
  assert.deepEqual(calls.filter(c => c.method !== 'GET').map(c => c.url), ['https://api.github.com/repos/example/repo/issues/8']);

  // Only a manual issue holds the title: it is left alone and the automation opens its own.
  const manual = githubMock([{ number: 3, title: UPDATE, user: { login: 'operator' }, body: 'Notes an operator wrote by hand.' }]);
  assert.deepEqual(await syncIssues([ownIssues()[0]], { repo: 'example/repo', token: 't', fetchImpl: manual.fetchImpl }), [{ action: 'opened', number: 12, title: UPDATE }]);
  assert.deepEqual(manual.calls.map(c => c.method), ['GET', 'POST'], 'no PATCH of the manual issue');
});

test('workflow: monthly and manual only, small, minimal permissions, no install', () => {
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/parcel-source-release-check.yml', import.meta.url), 'utf8').split('\r\n').join('\n');
  assert.match(workflow, /schedule:\n\s+- cron: '\d+ \d+ 1 \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+(push|pull_request|pull_request_target):/);
  assert.match(workflow, /\n  check:\n(\s+#[^\n]*\n)*    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}\n    runs-on: ubuntu-latest\n/, 'job-level main-only guard, before a runner is allocated');
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+issues: write\n/);
  assert.doesNotMatch(workflow, /npm (ci|install)|pnpm|yarn/);
  assert.match(workflow, /node apps\/viewer\/scripts\/check-parcel-releases\.mjs --github-issues/);
});

test('check: a layer without the acres field fails, since every parcel request would fail', async () => {
  const { fetchImpl } = mockFetch(baseRoutes({ [WISCONSIN.layerUrl]: { ...v12Layer, fields: [{ name: 'OBJECTID' }, { name: 'OWNERNME1' }] } }));
  const report = await checkAll([WISCONSIN], { fetchImpl, now });
  assert.equal(report.results[0].layer.up, false);
  assert.match(report.results[0].layer.reason, /no longer has acres field ASSDACRES/);
  assert.notEqual(exitCodeFor(report), 0);
});
