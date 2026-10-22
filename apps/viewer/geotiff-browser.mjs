// Use GeoTIFF's ESM entry point so Vite can bundle the runtime and its
// transitive dependencies. The browser distribution is a UMD script; importing
// it as an ES module does not reliably install `globalThis.GeoTIFF` in a
// production bundle and previously crashed the entire workspace at startup.
export { fromUrl, Pool } from './node_modules/geotiff/dist-module/geotiff.js';
