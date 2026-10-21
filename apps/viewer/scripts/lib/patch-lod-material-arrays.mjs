import fs from 'node:fs';
import path from 'node:path';

// These exact fragments belong to 3d-tiles-renderer 0.5.1. Patch source and its
// shipped bundle together; never silently accept a changed dependency layout.
export function patchLodMaterialArrays(packageRoot, patchExact) {
  const rendererSource = path.join(packageRoot, 'src/three/renderer/tiles/TilesRenderer.js');
  const memorySource = path.join(packageRoot, 'src/three/renderer/utils/MemoryUtils.js');
  patchExact(rendererSource,
    `\t\t\t\tconst material = c.material;
\t\t\t\tmaterials.push( c.material );

\t\t\t\tfor ( const key in material ) {

\t\t\t\t\tconst value = material[ key ];
\t\t\t\t\tif ( value && value.isTexture ) {

\t\t\t\t\t\ttextures.push( value );

\t\t\t\t\t}

\t\t\t\t}`,
    `\t\t\t\tfor ( const material of Array.isArray( c.material ) ? c.material : [ c.material ] ) {

\t\t\t\t\tif ( ! materials.includes( material ) ) materials.push( material );
\t\t\t\t\tfor ( const key in material ) {

\t\t\t\t\t\tconst value = material[ key ];
\t\t\t\t\t\tif ( value && value.isTexture && ! textures.includes( value ) ) textures.push( value );

\t\t\t\t\t}

\t\t\t\t}`,
    '3d-tiles-renderer source material-array resource disposal');
  patchExact(memorySource,
    `\t\t\tconst material = c.material;
\t\t\tfor ( const key in material ) {

\t\t\t\tconst value = material[ key ];
\t\t\t\tif ( value && value.isTexture && ! dedupeSet.has( value ) ) {

\t\t\t\t\ttotalBytes += getTextureByteLength( value );
\t\t\t\t\tdedupeSet.add( value );

\t\t\t\t}

\t\t\t}`,
    `\t\t\tfor ( const material of Array.isArray( c.material ) ? c.material : [ c.material ] ) {
\t\t\t\tfor ( const key in material ) {

\t\t\t\t\tconst value = material[ key ];
\t\t\t\t\tif ( value && value.isTexture && ! dedupeSet.has( value ) ) {

\t\t\t\t\t\ttotalBytes += getTextureByteLength( value );
\t\t\t\t\t\tdedupeSet.add( value );

\t\t\t\t\t}

\t\t\t\t}
\t\t\t}`,
    '3d-tiles-renderer source material-array texture accounting');

  const buildDirectory = path.join(packageRoot, 'build');
  const chunks = fs.readdirSync(buildDirectory).filter(name => /^renderer-[A-Za-z0-9_-]+\.js$/.test(name))
    .map(name => path.join(buildDirectory, name))
    .filter(file => fs.readFileSync(file, 'utf8').includes('//#region src/three/renderer/tiles/TilesRenderer.js'));
  if (chunks.length !== 1) throw new Error(`Expected one Three renderer resource chunk, found ${chunks.length}`);
  const [bundle] = chunks;
  patchExact(bundle,
    `\t\t\t\tlet t = e.material;
\t\t\t\tv.push(e.material);
\t\t\t\tfor (let e in t) {
\t\t\t\t\tlet n = t[e];
\t\t\t\t\tn && n.isTexture && b.push(n);
\t\t\t\t}`,
    `\t\t\t\tfor (const t of Array.isArray(e.material) ? e.material : [e.material]) {
\t\t\t\t\tif (!v.includes(t)) v.push(t);
\t\t\t\t\tfor (let e in t) {
\t\t\t\t\t\tlet n = t[e];
\t\t\t\t\t\tn && n.isTexture && !b.includes(n) && b.push(n);
\t\t\t\t\t}
\t\t\t\t}`,
    '3d-tiles-renderer bundle material-array resource disposal');
  patchExact(bundle,
    `\t\t\tlet r = e.material;
\t\t\tfor (let e in r) {
\t\t\t\tlet i = r[e];
\t\t\t\ti && i.isTexture && !t.has(i) && (n += Rt(i), t.add(i));
\t\t\t}`,
    `\t\t\tfor (const r of Array.isArray(e.material) ? e.material : [e.material]) {
\t\t\t\tfor (let e in r) {
\t\t\t\t\tlet i = r[e];
\t\t\t\t\ti && i.isTexture && !t.has(i) && (n += Rt(i), t.add(i));
\t\t\t\t}
\t\t\t}`,
    '3d-tiles-renderer bundle material-array texture accounting');
}
