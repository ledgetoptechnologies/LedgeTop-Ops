import { patchPotreeLocalClip } from './potree-local-clip-candidate.mjs';
import { patchPotreeCullNormals } from './potree-cull-normal-candidate.mjs';
import { createHash } from 'node:crypto';
import { EPT_SLICE_CAPABILITY } from '../ept-slice-capability.mjs';

export const POTREE_SLICE_CAPABILITY = EPT_SLICE_CAPABILITY;
export const POTREE_MARKED_OUTPUT_SHA256 = 'e3dd4e7b4732826fb0c13c64a1325858b464312948749cd1cc51d54bb633e69f';

// Each step validates both input and output hashes; order is mandatory.
// Isolated candidate only, not connected to the production image build.
export function patchPotreeCombinedClip(source) {
  const patched = patchPotreeCullNormals(patchPotreeLocalClip(source));
  const anchor = "Object.defineProperty(exports, '__esModule', { value: true });";
  if (patched.split(anchor).length !== 2) throw new Error('Potree capability export anchor missing or ambiguous');
  const result = patched.replace(anchor, `exports.ltdsSliceCapability = '${POTREE_SLICE_CAPABILITY}';\n\t${anchor}`);
  const hash = createHash('sha256').update(result).digest('hex');
  if (hash !== POTREE_MARKED_OUTPUT_SHA256) throw new Error(`Unexpected marked Potree bundle hash: ${hash}`);
  return result;
}
