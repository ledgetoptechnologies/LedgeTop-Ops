import { createHash } from 'node:crypto';

// Candidate only. Do not add to a production build without separate approval
// of rendering, picking, compatibility and release checks.
export const POTREE_INPUT_SHA256 = 'd86b62377d9f74a8269ce800d5c191f45dbed13b3cf48307a8200ff670710c45';
export const POTREE_OUTPUT_SHA256 = 'c528a5f62f9029b427acc6de334d30bfab1f99eba6eef2309c28bdc6370074b0';
const sha256 = source => createHash('sha256').update(source).digest('hex');
const SHADER = 'clipBoxes[i] * modelMatrix * vec4( position, 1.0 )';
const NODE = 'const lModelView = shader.uniformLocations["modelViewMatrix"];';

function replaceOnce(source, original, replacement) {
  if (source.split(original).length !== 2) throw new Error('Potree clip patch target missing or ambiguous');
  return source.replace(original, replacement);
}

export function patchPotreeLocalClip(source) {
  if (typeof source !== 'string' || sha256(source) !== POTREE_INPUT_SHA256) throw new Error('Unexpected Potree bundle hash');
  let patched = replaceOnce(source, SHADER, 'clipBoxes[i] * vec4( position, 1.0 )');
  patched = replaceOnce(patched, NODE, `if(material.clipBoxes && material.clipBoxes.length){
  const localBoxes=new Float32Array(material.clipBoxes.length*16);
  material.clipBoxes.forEach((box,index)=>localBoxes.set(box.inverse.clone().multiply(world).elements,index*16));
  gl.uniformMatrix4fv(shader.uniformLocations["clipBoxes[0]"],false,localBoxes);
}\n${NODE}`);
  if (sha256(patched) !== POTREE_OUTPUT_SHA256) throw new Error('Unexpected patched Potree bundle hash');
  return patched;
}
