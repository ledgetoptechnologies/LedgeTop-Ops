// Viewer product downloads. Source capabilities are used solely to obtain a
// short-lived, one-product ticket; source files never become JavaScript Blobs.
// The list and the download are offered to the Download dialog; the original
// model report keeps its own button.
export function sessionProductsUrl(assetRoot, origin = location.origin) {
  if (!assetRoot) return null;
  let url; try { url = new URL(assetRoot, origin); } catch { return null; }
  if (url.origin !== origin) return null;
  const match = /^\/session-assets\/([^/]+)\/([^/]+)\//.exec(url.pathname);
  return match ? `/session-products/${match[1]}/${match[2]}` : null;
}

export function safeProductTicket(value, origin = location.origin) {
  let url; try { url = new URL(value, origin); } catch { return null; }
  return url.origin === origin && /^\/session-product-downloads\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
    && !url.search && !url.hash ? url.href : null;
}

// Same rule as the server (publicSharePolicy reportAllowed): the model report has its own permission; a link or
// session from before it had one keeps the report with downloads. A present field must be exactly true.
export function reportPermitted(permissions) {
  if (!permissions || typeof permissions !== 'object') return false;
  return Object.hasOwn(permissions, 'report') ? permissions.report === true : permissions.download === true;
}

function formatSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Size unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = bytes ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function mountViewerProductDownloads({ reportHost, getAssetRoot, permitted, reportPermitted: reportGate = permitted, documentRef = document, fetchRef = fetch,
  origin = location.origin } = {}) {
  if (typeof getAssetRoot !== 'function') throw new Error('Product downloads need an asset root');
  let disposed = false, controller = null, generation = 0, currentBase = null, productsShown = false;
  const element = (tag, text, className) => {
    const node = documentRef.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
  };
  const allowed = () => typeof permitted === 'function' ? permitted() === true : permitted === true;
  const reportAllowed = () => typeof reportGate === 'function' ? reportGate() === true : reportGate === true;
  const reportContainer = element('section', '', 'viewer-product-controls');
  const reportOpen = element('button', 'Model report', 'tool-btn full viewer-product-open'); reportOpen.type = 'button';
  const reportStatus = element('p', '', 'hint'); reportStatus.setAttribute('role', 'status'); reportStatus.setAttribute('aria-live', 'polite');
  reportContainer.append(reportOpen, reportStatus); reportHost?.append(reportContainer);
  const style = element('style');
  style.textContent = '.viewer-product-controls{display:contents}#model-report-download .viewer-product-controls{display:grid;gap:6px;margin-top:8px}#model-report-download .viewer-product-controls p:empty{display:none}.viewer-product-open{width:100%}';
  documentRef.head.append(style);
  const cancel = () => { generation++; controller?.abort(); controller = null; reportOpen.disabled = false; };
  // One scope per model version and access: a list or a download that began in
  // another ends without effect.
  const scope = () => {
    const base = sessionProductsUrl(getAssetRoot(), origin);
    return !disposed && allowed() && base ? { base, epoch: generation } : null;
  };
  const current = (held) => !disposed && allowed() && held.epoch === generation && sessionProductsUrl(getAssetRoot(), origin) === held.base;
  const ended = () => new DOMException('Downloads changed.', 'AbortError');

  /** The registered products (without the model report, which has its own button). */
  async function list(signal) {
    const held = scope();
    if (!held) throw new Error('Downloads are not available for this view.');
    const response = await fetchRef(held.base, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(response.status === 403 ? 'Downloads are not permitted for this model.' : 'Could not load the downloads. Close and retry.');
    const data = await response.json();
    if (!current(held)) throw ended();
    const products = Array.isArray(data.products) ? data.products.filter(product => !reportHost || product.kind !== 'report') : [];
    return products.filter(product => product.grantUrl === `${held.base}/${encodeURIComponent(product.kind)}/download-grants`)
      .map(product => ({ kind: String(product.kind), label: String(product.label || product.kind), format: String(product.format || ''), size: formatSize(product.byteSize), base: held.base, epoch: held.epoch }));
  }

  /** Hands one product to the browser's own download, through a one-product ticket. */
  async function download(product, signal) {
    if (!product || !current(product)) throw new Error('Download access changed. Reopen Download to retry.');
    const expected = `${product.base}/${encodeURIComponent(product.kind)}/download-grants`;
    const response = await fetchRef(expected, { method: 'POST', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(response.status === 403 ? 'Download access expired or was revoked. Reopen Download to retry.' : 'This product could not be downloaded.');
    const grant = await response.json(), url = safeProductTicket(grant.url, origin);
    if (!url) throw new Error('Invalid download response.');
    if (disposed || !allowed() || product.epoch !== generation || !current(product)) throw ended();
    const link = element('a'); link.href = url; link.download = String(grant.fileName || 'product'); link.referrerPolicy = 'no-referrer';
    documentRef.body.append(link); link.click(); link.remove();
    return { fileName: link.download };
  }

  reportOpen.onclick = async () => {
    const base = sessionProductsUrl(getAssetRoot(), origin);
    if (disposed || !reportAllowed() || !base) return;
    cancel(); const epoch = generation;
    controller = new AbortController(); const signal = controller.signal;
    reportOpen.disabled = true; reportStatus.textContent = '';
    try {
      const response = await fetchRef(base, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 403 ? 'Downloads are not permitted for this model.' : 'Could not load the model report. Please retry.');
      const data = await response.json();
      if (disposed || epoch !== generation || !reportAllowed()) return;
      const expected = `${base}/report/download-grants`;
      const report = Array.isArray(data.products) && data.products.find(product => product.kind === 'report' && product.grantUrl === expected);
      if (!report) { reportStatus.textContent = 'No model report for this version.'; return; }
      const issued = await fetchRef(expected, { method: 'POST', signal, credentials: 'same-origin' });
      if (!issued.ok) throw new Error(issued.status === 403 ? 'Download access expired or was revoked.' : 'The model report could not be downloaded.');
      const grant = await issued.json(), url = safeProductTicket(grant.url, origin);
      if (!url) throw new Error('Invalid download response.');
      if (disposed || epoch !== generation || !reportAllowed()) return;
      const link = element('a'); link.href = url; link.download = String(grant.fileName || 'report.pdf'); link.referrerPolicy = 'no-referrer';
      documentRef.body.append(link); link.click(); link.remove();
      reportStatus.textContent = '';
    } catch (error) { if (error.name !== 'AbortError' && epoch === generation) reportStatus.textContent = error.message; }
    finally { if (epoch === generation) reportOpen.disabled = false; }
  };
  function refresh() {
    const nextBase = sessionProductsUrl(getAssetRoot(), origin), changed = currentBase !== nextBase;
    currentBase = nextBase;
    const reportShown = !reportContainer.hidden, productsWere = productsShown;
    productsShown = allowed() && Boolean(nextBase);
    reportContainer.hidden = !reportAllowed() || !nextBase;
    // Stop work only when its permission was just taken away or the model changed; a session renewal changes neither.
    const productsLost = productsWere && !productsShown, reportLost = reportShown && reportContainer.hidden;
    if (changed || productsLost || reportLost) { cancel(); reportOpen.disabled = false; reportStatus.textContent = ''; }
  }
  refresh();
  return { refresh, available: () => Boolean(scope()), list, download,
    destroy() { disposed = true; cancel(); reportContainer.remove(); style.remove(); } };
}
