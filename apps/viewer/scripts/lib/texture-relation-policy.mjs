// Candidate statistical relation only. These gates require independent natural-
// photo calibration before a recovery adapter can treat them as qualified proof.
export const TEXTURE_RELATION_POLICY = Object.freeze({
  revision: 'ltds-lossy-lod0-srgb-v1-candidate', regionEdge: 512, maximumEdge: 16384,
  imageRgbMae: 10, imageRgbRmse: 16, regionRgbMae: 16, regionRgbRmse: 24,
  alphaMaximum: 20, alphaMae: 2,
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const histogram = () => new Float64Array(256);
const counters = () => ({ samples: 0, absolute: 0, squared: 0, maximum: 0, maximumAt: null });
function add(value, error, x, y, channel) {
  value.samples++; value.absolute += error; value.squared += error * error;
  if (error > value.maximum) { value.maximum = error; value.maximumAt = { x, y, channel }; }
}
function statistics(value) {
  return { samples: value.samples, mae: value.samples ? value.absolute / value.samples : null,
    rmse: value.samples ? Math.sqrt(value.squared / value.samples) : null, maximum: value.samples ? value.maximum : null,
    maximumAt: value.maximumAt };
}
function quantiles(bins, count) {
  if (!count) return null;
  const result = {};
  for (const [key, fraction] of [['p50', .5], ['p95', .95], ['p99', .99], ['p999', .999]]) {
    const rank = Math.ceil(count * fraction); let cumulative = 0;
    for (let error = 0; error < bins.length; error++) {
      cumulative += bins[error]; if (cumulative >= rank) { result[key] = error; break; }
    }
  }
  return result;
}
const within = (value, mae, rmse) => !value.samples || (value.mae <= mae && value.rmse <= rmse);

// Consume contiguous RGBA8 row bands; hold counters/histograms and one region
// row only, never retain the caller's raw/decoded image buffers. Transparent RGB
// never dilutes visible RGB statistics. Alpha is compared at every pixel.
export class TextureRelationAccumulator {
  #width; #height; #row = 0; #rgb = counters(); #alpha = counters();
  #channels = Array.from({ length: 3 }, counters); #bins = Array.from({ length: 4 }, histogram);
  #rgbBins = histogram(); #active = null; #regions = []; #result = null;
  constructor({ width, height } = {}) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= TEXTURE_RELATION_POLICY.maximumEdge)) fail('lod_texture_relation_dimensions');
    this.#width = width; this.#height = height;
  }
  #closeRegionRow() {
    if (!this.#active) return;
    for (const region of this.#active) {
      const rgb = statistics(region.rgb);
      this.#regions.push({ x: region.x, y: region.y, width: Math.min(512, this.#width - region.x),
        height: Math.min(512, this.#height - region.y), visiblePixels: rgb.samples / 3, rgb,
        passed: within(rgb, TEXTURE_RELATION_POLICY.regionRgbMae, TEXTURE_RELATION_POLICY.regionRgbRmse) });
    }
    this.#active = null;
  }
  addRows(y, raw, decoded) {
    if (this.#result || y !== this.#row || ![raw, decoded].every(value => value instanceof Uint8Array
      && !(typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer))
      || !raw.byteLength || raw.byteLength !== decoded.byteLength || raw.byteLength % (this.#width * 4)) fail('lod_texture_relation_coverage');
    const rows = raw.byteLength / (this.#width * 4);
    if (this.#row + rows > this.#height) fail('lod_texture_relation_coverage');
    let offset = 0;
    for (let row = 0; row < rows; row++, this.#row++) {
      if (!this.#active) this.#active = Array.from({ length: Math.ceil(this.#width / 512) }, (_, column) =>
        ({ x: column * 512, y: this.#row, rgb: counters() }));
      for (let x = 0; x < this.#width; x++, offset += 4) {
        const alphaError = Math.abs(raw[offset + 3] - decoded[offset + 3]);
        add(this.#alpha, alphaError, x, this.#row, 3); this.#bins[3][alphaError]++;
        if (!raw[offset + 3]) continue;
        const region = this.#active[Math.floor(x / 512)];
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(raw[offset + channel] - decoded[offset + channel]);
          add(this.#rgb, error, x, this.#row, channel); add(this.#channels[channel], error, x, this.#row, channel);
          add(region.rgb, error, x, this.#row, channel);
          this.#rgbBins[error]++; this.#bins[channel][error]++;
        }
      }
      if ((this.#row + 1) % 512 === 0) this.#closeRegionRow();
    }
  }
  finish() {
    if (this.#row !== this.#height) fail('lod_texture_relation_coverage');
    if (this.#result) return structuredClone(this.#result);
    this.#closeRegionRow();
    const rgb = { ...statistics(this.#rgb), quantiles: quantiles(this.#rgbBins, this.#rgb.samples) };
    const alpha = { ...statistics(this.#alpha), quantiles: quantiles(this.#bins[3], this.#alpha.samples) };
    const imageRgbPass = within(rgb, TEXTURE_RELATION_POLICY.imageRgbMae, TEXTURE_RELATION_POLICY.imageRgbRmse);
    const alphaPass = alpha.maximum <= TEXTURE_RELATION_POLICY.alphaMaximum && alpha.mae <= TEXTURE_RELATION_POLICY.alphaMae;
    this.#result = { policyRevision: TEXTURE_RELATION_POLICY.revision, calibrationRequired: true,
      scope: 'full-count RGBA8 statistical comparison only; no geometry, source binding, decoder or universal pixel-equality claim',
      width: this.#width, height: this.#height, pixelsCompared: this.#alpha.samples, visiblePixels: this.#rgb.samples / 3,
      rgb, rgbChannels: this.#channels.map((channel, index) => ({ ...statistics(channel), quantiles: quantiles(this.#bins[index], channel.samples) })),
      alpha, regions: this.#regions, imageRgbPass, alphaPass,
      candidatePass: imageRgbPass && alphaPass && this.#regions.every(region => region.passed) };
    return structuredClone(this.#result);
  }
}
