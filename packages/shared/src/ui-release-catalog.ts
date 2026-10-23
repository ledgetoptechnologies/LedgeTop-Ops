/** Locally reproduced release candidates. Registration is not deployment approval.
 * Origin and authentication admission belong to each application's caller. */
import candidateCatalog from './ui-release-catalog.generated.json' with { type: 'json' };
import { resolveUiReleaseAsset, validateUiReleaseManifest, type UiReleaseManifest } from './ui-release-assets.ts';

if (candidateCatalog.schemaVersion !== 1) throw new Error('Invalid UI catalog version');
const releases: readonly UiReleaseManifest[] = Object.freeze(candidateCatalog.releases.map(validateUiReleaseManifest));
if (new Set(releases.map(release => `${release.application}:${release.releaseId}`)).size !== releases.length) {
  throw new Error('Duplicate UI release identity');
}

export function findUiReleaseManifest(application: 'operations' | 'client', releaseId: unknown): UiReleaseManifest | null {
  if (typeof releaseId !== 'string' || !/^[a-f0-9]{40}$/.test(releaseId)) return null;
  return releases.find(release => release.application === application && release.releaseId === releaseId) ?? null;
}

export function uiReleaseForRequest(application: 'operations' | 'client', url: string | URL): UiReleaseManifest | null {
  return releases.find(release => release.application === application && resolveUiReleaseAsset(url, release) !== null) ?? null;
}
