/** Offline policy only: performs no signature verification, promotion approval, HTTP,
 * installation or native-provider shutdown. Callers must obtain both trusted policy
 * and actual package/signature observations from independent approved mechanisms.
 * Browser authentication is not an AppInstaller background-download credential.
 */
export const publisherDisplayName = 'Ledge Top Technologies LLC';
export const updateBehavior = Object.freeze({ onLaunchHours: 12, backgroundHours: 8,
  showPrompt: false, updateBlocksActivation: false, forceDowngrade: false });

function requireThat(condition, reason) { if (!condition) throw new Error(reason); }
function text(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}
export function parseWindowsVersion(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Canonical four-part version required');
  const parts = value.split('.').map(Number);
  requireThat(parts.every(n => Number.isInteger(n) && n <= 65535), 'Version components exceed u16');
  return parts;
}
export function compareWindowsVersions(a, b) {
  const left = parseWindowsVersion(a), right = parseWindowsVersion(b);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function https(value) {
  requireThat(text(value, 2048) && /^https:\/\/[A-Za-z0-9.-]+\//.test(value) &&
    !/[\\%?#]/.test(value), 'Canonical HTTPS URL without escapes/query/fragment required');
  const url = new URL(value);
  requireThat(!url.username && !url.password && !url.port && !url.pathname.includes('//') &&
    !url.pathname.split('/').some(p => p === '.' || p === '..') && url.href === value,
  'Noncanonical URL or credentials/port refused');
  requireThat(/^[A-Za-z0-9._~/-]+$/.test(url.pathname), 'Unsafe URL path');
  return url;
}
export function validateUpdatePolicy(policy) {
  requireThat(policy?.schemaVersion === 1, 'Policy schema required');
  requireThat(policy.channels && typeof policy.channels === 'object' && !Array.isArray(policy.channels) &&
    Object.keys(policy.channels).length > 0 && Object.keys(policy.channels).every(k => k === 'pilot' || k === 'stable'),
    'Explicit approved channel set required');
  const channels = {};
  for (const channel of ['pilot', 'stable']) {
    const p = policy.channels?.[channel];
    if (!Object.hasOwn(policy.channels, channel)) continue; // Unconfigured stable must not block a reviewed pilot or become enabled implicitly.
    requireThat(p && text(p.packageName, 50) && /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/.test(p.packageName), 'Explicit package identity required');
    requireThat(text(p.publisher) && /^CN=.+/.test(p.publisher) &&
      text(p.signingProfileId, 256) && p.signingProfileVerified === true,
    'Exact publisher DN from verified signing profile required');
    requireThat(p.architecture === 'x64', 'Only approved x64 architecture supported');
    const feed = https(p.feedUrl), base = https(p.packageBaseUrl);
    requireThat(text(p.origin) && feed.origin === p.origin && base.origin === p.origin &&
      feed.pathname.endsWith('.appinstaller') && !base.pathname.endsWith('/'), 'Approved same-origin feed/package base required');
    channels[channel] = Object.freeze({ packageName: p.packageName, publisher: p.publisher,
      signingProfileId: p.signingProfileId, signingProfileVerified: true, architecture: p.architecture,
      origin: p.origin, feedUrl: p.feedUrl, packageBaseUrl: p.packageBaseUrl });
  }
  const { pilot, stable } = channels;
  requireThat(!pilot || !stable || pilot.packageName !== stable.packageName && pilot.feedUrl !== stable.feedUrl &&
    pilot.packageBaseUrl !== stable.packageBaseUrl, 'Pilot and stable identities/feeds/package bases must be distinct');
  return Object.freeze({ schemaVersion: 1, channels: Object.freeze(channels) });
}

/** The observation is a caller-supplied result of actual trusted signature and
 * manifest inspection of the exact artifact. A JSON boolean does not verify it.
 * Policy validation never supplies release/promotion authorization.
 */
export function validateRelease(policy, release, signatureObservation) {
  const policies = validateUpdatePolicy(policy).channels;
  requireThat(release && Object.hasOwn(policies, release.channel), 'Unapproved channel');
  const p = policies[release.channel];
  parseWindowsVersion(release.version);
  requireThat(release.packageName === p.packageName && release.publisher === p.publisher &&
    release.architecture === p.architecture, 'Release identity does not match channel');
  requireThat(typeof release.sha256 === 'string' && /^[0-9a-f]{64}$/.test(release.sha256) &&
    Number.isSafeInteger(release.sizeBytes) && release.sizeBytes > 0 &&
    typeof release.sourceCommit === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(release.sourceCommit), 'Immutable artifact metadata required');
  https(release.packageUrl);
  requireThat(release.packageUrl === `${p.packageBaseUrl}/${release.version}/${release.sha256}.msix`, 'Exact immutable version/digest package path required');
  const s = signatureObservation;
  requireThat(s?.verified === true && s.trusted === true && s.signingProfileId === p.signingProfileId,
    'Actual verified trusted signature observation required');
  requireThat(s.compiledChannel === release.channel && s.developerBuild === false,
    'Observed inner application channel must match the package with no developer marker');
  for (const key of ['packageName', 'publisher', 'architecture', 'version', 'sha256', 'sizeBytes', 'sourceCommit'])
    requireThat(s[key] === release[key], `Signature/artifact observation mismatch: ${key}`);
  return Object.freeze({ channel: release.channel, packageName: release.packageName, publisher: release.publisher,
    architecture: release.architecture, version: release.version, sha256: release.sha256,
    sizeBytes: release.sizeBytes, sourceCommit: release.sourceCommit, packageUrl: release.packageUrl });
}
function xml(value) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
export function renderAppInstaller(policy, release, observation) {
  const r = validateRelease(policy, release, observation), p = validateUpdatePolicy(policy).channels[r.channel];
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!-- Offline policy output: requires independent signature verification and promotion approval. -->\n` +
    `<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2021" Version="${r.version}" Uri="${xml(p.feedUrl)}">\n` +
    `  <MainPackage Name="${xml(r.packageName)}" Publisher="${xml(r.publisher)}" Version="${r.version}" ProcessorArchitecture="${r.architecture}" Uri="${xml(r.packageUrl)}" />\n` +
    `  <UpdateSettings><OnLaunch HoursBetweenUpdateChecks="12" ShowPrompt="false" UpdateBlocksActivation="false" /><AutomaticBackgroundTask /></UpdateSettings>\n</AppInstaller>\n`;
}

/** Both installed and candidate artifacts require observed provenance. A rollback
 * is a NEW higher-version release; rollbackPayloadVersion records an older payload
 * target, not a permission to install a lower package version or proof of its bytes.
 */
export function selectUpdate(policy, installed, installedObservation, candidate, candidateObservation, options = {}) {
  const old = validateRelease(policy, installed, installedObservation);
  const next = validateRelease(policy, candidate, candidateObservation);
  requireThat(old.channel === next.channel, 'Cross-channel update refused');
  const order = compareWindowsVersions(next.version, old.version);
  if (order === 0) {
    requireThat(old.sha256 === next.sha256 && old.sizeBytes === next.sizeBytes && old.sourceCommit === next.sourceCommit,
      'Same version cannot be replaced with different immutable metadata');
  }
  requireThat(order >= 0, 'Downgrade refused; rollback requires a forward release');
  if (options.rollbackPayloadVersion !== undefined) {
    requireThat(compareWindowsVersions(options.rollbackPayloadVersion, old.version) < 0 && order > 0,
      'Rollback requires older payload target and a new higher package version');
  }
  return order > 0 ? next : null;
}
