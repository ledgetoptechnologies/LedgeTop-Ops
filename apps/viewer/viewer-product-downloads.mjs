// Viewer-only product chooser. Source capabilities are used solely to obtain a
// short-lived, one-product ticket; source files never become JavaScript Blobs.
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

function formatSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Size unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = bytes ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function mountViewerProductDownloads({ host, reportHost, getAssetRoot, permitted, documentRef = document, fetchRef = fetch,
  origin = location.origin } = {}) {
  if (!host || typeof getAssetRoot !== 'function') throw new Error('Product chooser needs a host and asset root');
  let disposed = false, controller = null, generation = 0, currentBase = null;
  const element = (tag, text, className) => {
    const node = documentRef.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
  };
  const allowed = () => typeof permitted === 'function' ? permitted() === true : permitted === true;
  const container = element('section', '', 'viewer-product-controls');
  const open = element('button', 'Download products', 'viewer-product-open'); open.type = 'button';
  container.append(open); host.append(container);
  const reportContainer = element('section', '', 'viewer-product-controls');
  const reportOpen = element('button', 'Model report — processing & quality', 'viewer-product-open'); reportOpen.type = 'button';
  const reportStatus = element('p'); reportStatus.setAttribute('role', 'status'); reportStatus.setAttribute('aria-live', 'polite');
  reportContainer.append(reportOpen, reportStatus); reportHost?.append(reportContainer);
  const dialog = element('dialog', '', 'viewer-product-dialog'); dialog.setAttribute('aria-label', 'Download model products');
  const heading = element('h2', 'Download products');
  const close = element('button', 'Close', 'viewer-product-close'); close.type = 'button';
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = element('div', '', 'viewer-product-list');
  dialog.append(heading, close, status, list); documentRef.body.append(dialog);
  const style = element('style');
  style.textContent = '.viewer-product-controls{margin-top:12px}.viewer-product-open{width:100%;padding:9px}.viewer-product-dialog{width:min(440px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#111216;color:#eee;border:1px solid #444;border-radius:12px;padding:18px}.viewer-product-dialog::backdrop{background:#000a}.viewer-product-dialog h2{font-size:17px;margin:0 60px 14px 0}.viewer-product-close{position:absolute;right:14px;top:12px}.viewer-product-list{display:grid;gap:8px}.viewer-product-item{display:block;width:100%;text-align:left;padding:12px;background:#1b1c21;color:#eee;border:1px solid #444;border-radius:8px;cursor:pointer}.viewer-product-item small{display:block;color:#a9b2c1;margin-top:4px}.viewer-product-item:focus-visible,.viewer-product-dialog button:focus-visible{outline:2px solid #ee5007;outline-offset:2px}.viewer-product-item:disabled{opacity:.6;cursor:wait}.viewer-product-dialog p{font-size:12px;line-height:1.5;color:#adb6c4}';
  documentRef.head.append(style);
  const cancel = () => { generation++; controller?.abort(); controller = null; reportOpen.disabled = false; };
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { cancel(); open.focus(); });
  async function load() {
    cancel(); const epoch = generation;
    const base = sessionProductsUrl(getAssetRoot(), origin);
    if (disposed || !allowed() || !base) { status.textContent = 'Downloads are not available for this view.'; return; }
    controller = new AbortController(); const signal = controller.signal;
    list.replaceChildren(); status.textContent = 'Loading available products…';
    try {
      const response = await fetchRef(base, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 403 ? 'Downloads are not permitted for this model.' : 'Could not load products. Close and retry.');
      const data = await response.json();
      if (disposed || epoch !== generation || !allowed()) return;
      const products = Array.isArray(data.products) ? data.products.filter(product => !reportHost || product.kind !== 'report') : [];
      status.textContent = products.length ? 'Choose an existing product. Progress appears in your browser Downloads panel.' : 'No downloadable products are registered for this view.';
      for (const product of products) {
        const expected = `${base}/${encodeURIComponent(product.kind)}/download-grants`;
        if (product.grantUrl !== expected) continue;
        const item = element('button', '', 'viewer-product-item'); item.type = 'button';
        item.append(element('strong', String(product.label || product.kind)), element('small', `${product.format || ''} · ${formatSize(product.byteSize)}`));
        item.onclick = async () => {
          if (disposed || !allowed() || epoch !== generation) return;
          item.disabled = true;
          try {
            const response = await fetchRef(expected, { method: 'POST', credentials: 'same-origin', signal });
            if (!response.ok) throw new Error(response.status === 403 ? 'Download access expired or was revoked. Reopen Downloads to retry.' : 'This product could not be downloaded.');
            const grant = await response.json(), url = safeProductTicket(grant.url, origin);
            if (!url) throw new Error('Invalid download response.');
            if (disposed || epoch !== generation || !allowed()) return;
            const link = element('a'); link.href = url; link.download = String(grant.fileName || 'product'); link.referrerPolicy = 'no-referrer';
            documentRef.body.append(link); link.click(); link.remove();
            status.textContent = 'Download handed to your browser. Check its Downloads panel for progress.';
          } catch (error) { if (error.name !== 'AbortError' && epoch === generation) status.textContent = error.message; }
          finally { item.disabled = false; }
        };
        list.append(item);
      }
    } catch (error) { if (error.name !== 'AbortError' && epoch === generation) status.textContent = error.message; }
  }
  open.onclick = () => { if (allowed()) { dialog.showModal(); void load(); } };
  reportOpen.onclick = async () => {
    const base = sessionProductsUrl(getAssetRoot(), origin);
    if (disposed || !allowed() || !base) return;
    cancel(); const epoch = generation;
    controller = new AbortController(); const signal = controller.signal;
    reportOpen.disabled = true; reportStatus.textContent = 'Finding the original model report…';
    try {
      const response = await fetchRef(base, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 403 ? 'Downloads are not permitted for this model.' : 'Could not load the model report. Please retry.');
      const data = await response.json();
      if (disposed || epoch !== generation || !allowed()) return;
      const expected = `${base}/report/download-grants`;
      const report = Array.isArray(data.products) && data.products.find(product => product.kind === 'report' && product.grantUrl === expected);
      if (!report) { reportStatus.textContent = 'No original processing and quality report is available for this model version.'; return; }
      const issued = await fetchRef(expected, { method: 'POST', signal, credentials: 'same-origin' });
      if (!issued.ok) throw new Error(issued.status === 403 ? 'Download access expired or was revoked.' : 'The model report could not be downloaded.');
      const grant = await issued.json(), url = safeProductTicket(grant.url, origin);
      if (!url) throw new Error('Invalid download response.');
      if (disposed || epoch !== generation || !allowed()) return;
      const link = element('a'); link.href = url; link.download = String(grant.fileName || 'report.pdf'); link.referrerPolicy = 'no-referrer';
      documentRef.body.append(link); link.click(); link.remove();
      reportStatus.textContent = 'Original report download started. Check your browser Downloads panel.';
    } catch (error) { if (error.name !== 'AbortError' && epoch === generation) reportStatus.textContent = error.message; }
    finally { if (epoch === generation) reportOpen.disabled = false; }
  };
  function refresh() {
    const nextBase = sessionProductsUrl(getAssetRoot(), origin), changed = currentBase !== nextBase;
    currentBase = nextBase;
    container.hidden = !allowed() || !nextBase;
    reportContainer.hidden = container.hidden;
    if (container.hidden || changed) { cancel(); reportOpen.disabled = false; reportStatus.textContent = ''; if (dialog.open) dialog.close(); }
  }
  refresh();
  return { refresh, destroy() { disposed = true; cancel(); dialog.remove(); container.remove(); reportContainer.remove(); style.remove(); } };
}
