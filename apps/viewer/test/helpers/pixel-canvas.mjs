// A small software canvas: rectangles, strokes and text boxes become real
// pixels, so what covers what can be checked without a browser.
export function pixelCanvasFactory(log) {
  return () => {
    let data = null, stride = 0, path = [], state = { fillStyle: '#000000', strokeStyle: '#000000', font: '10px x', lineWidth: 1 };
    const stack = [], texts = [], canvas = { width: 0, height: 0 };
    const colour = style => {
      if (style.startsWith('#')) return [1, 3, 5].map(i => parseInt(style.slice(i, i + 2), 16)).concat(1);
      const [r, g, b, a = 1] = style.match(/[\d.]+/g).map(Number);
      return [r, g, b, a];
    };
    const dot = (x, y, [r, g, b, a]) => {
      if (!data || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
      const i = (y * canvas.width + x) * 4;
      [r, g, b].forEach((v, k) => { data[i + k] = Math.round(v * a + data[i + k] * (1 - a)); });
      data[i + 3] = Math.max(data[i + 3], Math.round(a * 255));
    };
    const ready = () => { stride = canvas.width; data ||= new Uint8ClampedArray(canvas.width * canvas.height * 4); };
    const rect = (x, y, w, h, c) => { ready(); for (let yy = Math.round(y); yy < Math.round(y + h); yy++) for (let xx = Math.round(x); xx < Math.round(x + w); xx++) dot(xx, yy, c); };
    const px = () => Number(/([\d.]+)px/.exec(state.font)[1]);
    const width = text => text.length * px() * 0.55;
    const ctx = {
      save() { stack.push({ ...state }); }, restore() { state = stack.pop(); },
      measureText: text => ({ width: width(text) }),
      putImageData(image, x = 0, y = 0) {
        if (!x && !y && image.data.length === canvas.width * canvas.height * 4) { stride = canvas.width; data = new Uint8ClampedArray(image.data); return; }
        ready();
        const w = image.width ?? canvas.width;
        for (let r = 0; r * w * 4 < image.data.length; r++) data.set(image.data.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * canvas.width + x) * 4);
      },
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      getImageData(x, y, w, h) { const out = new Uint8ClampedArray(w * h * 4); for (let r = 0; r < h; r++) out.set(data.subarray(((y + r) * canvas.width + x) * 4, ((y + r) * canvas.width + x + w) * 4), r * w * 4); return { data: out }; },
      fillRect(x, y, w, h) { rect(x, y, w, h, colour(state.fillStyle)); },
      fillText(text, x, y) { texts.push({ text, x, y, px: px(), width: width(text) }); rect(x, y - px() * 0.35, width(text), px() * 0.7, colour(state.fillStyle)); },
      strokeText() {}, translate() {}, rotate() {}, closePath() {},
      beginPath() { path = []; }, moveTo(x, y) { path.push([x, y, true]); }, lineTo(x, y) { path.push([x, y, false]); }, rect(x, y, w, h) { path.box = [x, y, w, h]; },
      fill() { if (path.box) rect(...path.box, colour(state.fillStyle)); },
      stroke() {
        const half = state.lineWidth / 2, c = colour(state.strokeStyle);
        for (let i = 1; i < path.length; i++) {
          if (path[i][2]) continue;
          const [x0, y0] = path[i - 1], [x1, y1] = path[i], steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
          for (let s = 0; s <= steps; s++) rect(x0 + (x1 - x0) * s / steps - half, y0 + (y1 - y0) * s / steps - half, half * 2, half * 2, c);
        }
      },
    };
    for (const key of ['lineJoin', 'lineCap', 'textBaseline', 'textAlign']) ctx[key] = '';
    for (const key of Object.keys(state)) Object.defineProperty(ctx, key, { get: () => state[key], set: value => { state[key] = value; } });
    canvas.getContext = () => ctx;
    canvas.toBlob = cb => cb(new Blob(['png'], { type: 'image/png' }));
    log.push({ texts, ctx, pixel: (x, y) => { const i = (y * stride + x) * 4; return Array.from(data.slice(i, i + 4)); } });
    return canvas;
  };
}
