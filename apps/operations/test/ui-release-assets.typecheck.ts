// Included by the ordinary Operations typecheck, without wiring the helper into
// the deployed Worker. This checks its contract against the actual generated
// asset binding and the application's combined Workers/Node platform types.
import type { UiAssetFetcher, UiReleaseManifest } from '../../../packages/shared/src/ui-release-assets';
import type { Env } from '../src/worker/types';

export type UiReleaseManifestTypecheck = UiReleaseManifest;
export function uiReleaseBindingTypecheck(binding: Env['ASSETS']): UiAssetFetcher {
  return binding;
}
