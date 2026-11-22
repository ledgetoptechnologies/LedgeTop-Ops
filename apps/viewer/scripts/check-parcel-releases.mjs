#!/usr/bin/env node
// Monthly check of the parcel-source registry (server/parcelSources.js).
//
// For each source with a discovery rule:
//   (a) the configured layer URL must still answer as a usable polygon layer
//       with the configured id field;
//   (b) look for a newer release: the configured layer's own name and credit
//       (a release replaced in place), the ArcGIS Online search API scoped to
//       the publishing organisation, and the organisation's REST services
//       directory (a release published as a new service);
//   (c) print a report. Exit 1 only when a configured layer is down. A newer
//       release is reported (and, with --github-issues, filed as an issue) but
//       is not an error.
//
// It never edits the registry: field names can change between releases, so a
// person or agent updates parcelSources.js after checking the new release.
//
// Usage: node scripts/check-parcel-releases.mjs [--github-issues]
//   --github-issues  open or update one issue per finding (fixed titles, so a
//                    finding never duplicates). Needs GITHUB_TOKEN and
//                    GITHUB_REPOSITORY. Exit 2 if the issue cannot be saved.
// Plain Node 24, built-in fetch, no dependencies.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { PARCEL_SOURCES } = require('../server/parcelSources.js');

const TIMEOUT_MS = 20_000;

async function getJson(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    let body;
    try { body = JSON.parse(await response.text()); } catch { return { ok: false, reason: 'response is not JSON' }; }
    // ArcGIS reports most errors as HTTP 200 with an error object.
    if (!body || typeof body !== 'object') return { ok: false, reason: 'empty response' };
    if (body.error) return { ok: false, reason: `service error ${body.error.code ?? ''} ${body.error.message ?? ''}`.trim() };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : `request failed (${error?.cause?.code || error?.message || 'unknown'})` };
  }
}

function withQuery(url, params) {
  const out = new URL(url);
  for (const [key, value] of Object.entries(params)) out.searchParams.set(key, value);
  return out.href;
}

const sameUrl = (a, b) => String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();

// Highest release number named in any of the texts, or null.
export function releaseVersion(texts, patterns) {
  let best = null;
  for (const text of texts.flat()) {
    if (typeof text !== 'string') continue;
    for (const pattern of patterns) {
      for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
        const value = Number(match[1]);
        if (Number.isInteger(value) && (best === null || value > best)) best = value;
      }
    }
  }
  return best;
}

// (a) Does the configured layer still answer, as a layer the Viewer can query?
export async function checkLayer(source, { fetchImpl = globalThis.fetch } = {}) {
  const result = await getJson(withQuery(source.layerUrl, { f: 'json' }), fetchImpl);
  if (!result.ok) return { up: false, reason: result.reason };
  const layer = result.body;
  if (layer.type !== 'Feature Layer') return { up: false, reason: `not a feature layer (type ${layer.type ?? 'missing'})` };
  if (layer.geometryType !== 'esriGeometryPolygon') return { up: false, reason: `not a polygon layer (${layer.geometryType ?? 'missing'})` };
  const fields = Array.isArray(layer.fields) ? layer.fields.map(field => field?.name) : [];
  if (!fields.includes(source.query.idField)) return { up: false, reason: `the layer no longer has field ${source.query.idField}` };
  const warnings = [];
  const sr = layer.extent?.spatialReference;
  if (sr && ![sr.wkid, sr.latestWkid].includes(source.query.wkid)) warnings.push(`layer spatial reference is now ${sr.latestWkid ?? sr.wkid}, not ${source.query.wkid}`);
  return { up: true, name: layer.name ?? null, version: releaseVersion([layer.name, layer.copyrightText], source.discovery.versionPatterns), warnings };
}

// (b) Releases the publishing organisation has online, with their versions.
export async function findReleases(source, { fetchImpl = globalThis.fetch } = {}) {
  const d = source.discovery;
  const name = new RegExp(d.namePattern, 'i');
  const candidates = [], warnings = [];

  const search = await getJson(withQuery(`${d.portalUrl}/sharing/rest/search`, {
    q: `orgid:${d.orgId} AND type:"Feature Service" AND ${d.searchText}`, f: 'json', num: '100', sortField: 'modified', sortOrder: 'desc',
  }), fetchImpl);
  if (!search.ok) warnings.push(`ArcGIS search failed: ${search.reason}`);
  else for (const item of Array.isArray(search.body.results) ? search.body.results : []) {
    if (!name.test(item?.title || '') && !name.test(item?.name || '')) continue;
    const version = releaseVersion([item.title, item.name, item.snippet, Array.isArray(item.tags) ? item.tags : []], d.versionPatterns);
    if (version !== null) candidates.push({ via: 'ArcGIS search', title: item.title || item.name, url: item.url || null, version });
  }

  const directory = await getJson(withQuery(d.servicesDirectory, { f: 'json' }), fetchImpl);
  if (!directory.ok) warnings.push(`services directory failed: ${directory.reason}`);
  else for (const service of Array.isArray(directory.body.services) ? directory.body.services : []) {
    if (service?.type !== 'FeatureServer' || !name.test(service.name || '')) continue;
    const serviceUrl = service.url || `${d.servicesDirectory}/${encodeURIComponent(service.name)}/FeatureServer`;
    const info = await getJson(withQuery(serviceUrl, { f: 'json' }), fetchImpl);
    if (!info.ok) { warnings.push(`service ${service.name} failed: ${info.reason}`); continue; }
    for (const layer of Array.isArray(info.body.layers) ? info.body.layers : []) {
      const version = releaseVersion([layer?.name], d.versionPatterns);
      if (version !== null) candidates.push({ via: 'services directory', title: `${service.name} / ${layer.name}`, url: `${serviceUrl}/${layer.id}`, version });
    }
  }
  if (!search.ok && !directory.ok) warnings.push('could not look for a newer release this time');
  return { candidates, warnings };
}

export async function checkSource(source, options = {}) {
  const current = source.discovery.currentVersion;
  const layer = await checkLayer(source, options);
  const found = await findReleases(source, options);
  const candidates = [...found.candidates];
  if (layer.up && layer.version !== null) candidates.push({ via: 'configured layer', title: layer.name, url: source.layerUrl, version: layer.version });
  const newest = candidates.filter(c => c.version > current).sort((a, b) => b.version - a.version)[0] || null;
  return {
    id: source.id, region: source.region, release: source.release, currentVersion: current, layerUrl: source.layerUrl,
    layer, newer: newest ? { ...newest, inPlace: sameUrl(newest.url, source.layerUrl) } : null,
    warnings: [...(layer.warnings || []), ...found.warnings],
  };
}

export async function checkAll(sources = PARCEL_SOURCES, options = {}) {
  const results = [];
  for (const source of sources) if (source.discovery) results.push(await checkSource(source, options));
  return { checkedAt: (options.now ? options.now() : new Date()).toISOString(), results };
}

export const exitCodeFor = report => (report.results.some(r => !r.layer.up) ? 1 : 0);

export function formatReport(report) {
  const lines = [`Parcel source release check, ${report.checkedAt}`];
  if (!report.results.length) lines.push('No registered source has a discovery rule.');
  for (const r of report.results) {
    lines.push('', `${r.region} (${r.id}), configured release ${r.release}`, `  layer: ${r.layerUrl}`);
    lines.push(r.layer.up ? `  OK: the configured layer answers${r.layer.name ? ` (${r.layer.name})` : ''}.` : `  DOWN: the configured layer does not answer: ${r.layer.reason}.`);
    if (!r.newer) lines.push(`  No release newer than V${r.currentVersion} found.`);
    else if (r.newer.inPlace) lines.push(`  NEWER RELEASE: the configured layer now reports V${r.newer.version}. Check its fields, then update the release in parcelSources.js.`);
    else lines.push(`  NEWER RELEASE: V${r.newer.version} "${r.newer.title}" (${r.newer.via})${r.newer.url ? ` at ${r.newer.url}` : ''}. Check its fields, then update parcelSources.js.`);
    for (const warning of r.warnings) lines.push(`  warning: ${warning}`);
  }
  return lines.join('\n');
}

const REGISTRY_PATH = 'apps/viewer/server/parcelSources.js';

// The only author whose issues this check edits.
export const AUTOMATION_AUTHOR = 'github-actions[bot]';
// Hidden, stable marker naming the source and finding; an issue is the
// automation's own only with this marker and the automation author.
export const issueMarker = (sourceId, kind) => `<!-- parcel-source-release-check:${sourceId}:${kind} -->`;

// One issue per finding, with a fixed title so a repeat finding updates the
// automation's open issue instead of opening another.
export function issuesFor(report) {
  const issues = [];
  const add = (r, kind, title, lines) => {
    const marker = issueMarker(r.id, kind);
    issues.push({ title, marker, body: [...lines, '', 'Opened by the parcel source release check. It never changes the registry itself.', marker].join('\n') });
  };
  for (const r of report.results) {
    if (!r.layer.up) add(r, 'down', `Parcel source down: ${r.region}`,
      [`The configured ${r.region} parcel layer did not answer the monthly check.`, '',
        `- Layer: ${r.layerUrl}`, `- Reason: ${r.layer.reason}`, `- Checked: ${report.checkedAt}`, '',
        'Property lines for this region show "service unavailable" while this lasts. If the state moved the layer, find the new release, check its fields and update `' + REGISTRY_PATH + '`.']);
    if (r.newer) add(r, 'update', `Parcel source update available: ${r.region} V${r.newer.version}`,
      [`A newer ${r.region} parcel release was found. The Viewer still uses ${r.release}.`, '',
        `- Found: ${r.newer.title} (${r.newer.via})`, `- URL: ${r.newer.url || 'not listed'}`,
        r.newer.inPlace ? '- The configured layer itself now reports this release (replaced in place).' : `- Configured layer: ${r.layerUrl}`,
        `- Checked: ${report.checkedAt}`, '',
        'To adopt it: read the new layer\'s metadata (`?f=json`), confirm the id field, spatial reference (Web Mercator) and extent, then update `layerUrl`, `release`, `credit` and `discovery.currentVersion` in `' + REGISTRY_PATH + '` and run the property-lines tests.']);
  }
  return issues;
}

// Create or update each issue through the GitHub REST API.
export async function syncIssues(issues, { repo, token, fetchImpl = globalThis.fetch, apiUrl = 'https://api.github.com' } = {}) {
  if (!issues.length) return [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required for --github-issues');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'parcel-source-release-check', 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repo}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const open = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await call('GET', `/issues?state=open&per_page=100&page=${page}`);
    open.push(...batch.filter(item => !item.pull_request));
    if (batch.length < 100) break;
  }
  const actions = [];
  for (const issue of issues) {
    // Only the automation's own issue is edited; a same-title issue someone
    // else opened is left alone.
    const existing = open.find(item => item.title === issue.title && item.user?.login === AUTOMATION_AUTHOR
      && typeof item.body === 'string' && item.body.includes(issue.marker));
    if (existing) { await call('PATCH', `/issues/${existing.number}`, { body: issue.body }); actions.push({ action: 'updated', number: existing.number, title: issue.title }); }
    else { const created = await call('POST', '/issues', { title: issue.title, body: issue.body }); actions.push({ action: 'opened', number: created.number, title: issue.title }); }
  }
  return actions;
}

async function main(argv) {
  const report = await checkAll();
  console.log(formatReport(report));
  let code = exitCodeFor(report);
  if (argv.includes('--github-issues')) {
    try {
      const actions = await syncIssues(issuesFor(report), { repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
      for (const a of actions) console.log(`Issue #${a.number} ${a.action}: ${a.title}`);
      if (!actions.length) console.log('Nothing to report as an issue.');
    } catch (error) {
      console.error(`Could not save the issue: ${error.message}`);
      code = code || 2;
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
