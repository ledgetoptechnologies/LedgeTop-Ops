(function exposePointCloudHealth(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudHealth = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function pointCloudHealthFactory() {
  'use strict';

  const FAILURES = Object.freeze({
    authorization_required: 'Point-cloud access needs renewal. Reopen this model from the Viewer workspace if access does not recover.',
    authorization_unavailable: 'Point-cloud access could not be renewed. Reopen this model from the Viewer workspace.',
    startup_timeout: 'The point-cloud viewer did not start in time. Retry, then check the Viewer service if this continues.',
    load_timeout: 'Point-cloud metadata did not arrive in time. Check access to the published EPT data, then retry.',
    node_timeout: 'Point-cloud metadata loaded, but no points arrived. Check the EPT node files and byte-range responses, then retry.',
    resource_failed: 'A point-cloud viewer component failed to load. Retry, then check the Viewer image if this continues.',
    runtime_unavailable: 'The point-cloud viewer components did not initialize. Retry, then update or restart the Viewer if this continues.',
    metadata_failed: 'Point-cloud metadata could not be loaded. Check access to the published EPT data, then retry.',
    runtime_error: 'The point-cloud viewer stopped unexpectedly. Retry, then open browser diagnostics and use the displayed reference if this continues.',
    not_configured: 'No point cloud is configured for this project.',
  });

  function hasVisiblePointCloudNodes(pointCloud) {
    if (!Array.isArray(pointCloud?.visibleNodes)) return false;
    return pointCloud.visibleNodes.some((node) => Boolean(
      node?.sceneNode?.geometry && node.sceneNode.visible !== false,
    ));
  }

  function createPointCloudHealth(options) {
    const win = options.window;
    const doc = options.document;
    const loading = doc.getElementById('pc-loading');
    const loadingText = doc.getElementById('pc-loading-text');
    const status = doc.getElementById('pc-status');
    const retry = doc.getElementById('pc-retry');
    const setTimer = options.setTimeout || win.setTimeout.bind(win);
    const clearTimer = options.clearTimeout || win.clearTimeout.bind(win);
    const reload = options.reload || (() => win.location.reload());
    const correlationId = /^[0-9a-f-]{8,64}$/i.test(options.correlationId || '') ? options.correlationId : 'unavailable';
    const revision = /^[0-9a-f]{40}$/i.test(options.buildRevision || '') ? options.buildRevision.toLowerCase() : 'unavailable';
    const timeouts = {
      startup: options.startupTimeoutMs || 30_000,
      load: options.loadTimeoutMs || 60_000,
      nodes: options.nodeTimeoutMs || 45_000,
    };
    let timer = null;
    let phase = 'starting';
    let failureCode = null;
    let phaseBeforeAccess = null;

    function stableStage() {
      if (phase === 'starting') return 'startup';
      if (phase === 'loading-metadata') return 'metadata';
      if (phase === 'loading-nodes' || phase === 'ready') return 'nodes';
      return 'runtime';
    }

    function diagnostic(event, code, stage = stableStage()) {
      const safeCode = Object.hasOwn(FAILURES, code) ? code : null;
      const details = { correlationId, revision, stage };
      if (event === 'failure' && safeCode) console.warn('[point-cloud-runtime] failure', { ...details, code: safeCode });
      else if (event === 'metadata_ready') console.info('[point-cloud-runtime] metadata_ready', details);
      else if (event === 'points_visible') console.info('[point-cloud-runtime] points_visible', details);
    }

    function notify(type, code, stage = stableStage()) {
      if (!win.parent || win.parent === win || typeof win.parent.postMessage !== 'function') return;
      win.parent.postMessage({ source: 'ltds-pointcloud', type, code, correlationId, stage, revision }, win.location.origin);
    }

    function clearWatchdog() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function showLoading(message) {
      if (loadingText) loadingText.textContent = message;
      loading?.classList.remove('hidden', 'failed');
      if (retry) retry.hidden = true;
    }

    function arm(nextPhase, timeoutMs, code, message) {
      if (phase === 'ready' || phase === 'failed') return;
      phase = nextPhase;
      clearWatchdog();
      showLoading(message);
      timer = setTimer(() => fail(code), timeoutMs);
    }

    function fail(code, { retryable = true } = {}) {
      if (phase === 'ready' || phase === 'failed') return;
      const failedStage = stableStage();
      phase = 'failed';
      failureCode = Object.hasOwn(FAILURES, code) ? code : 'runtime_error';
      diagnostic('failure', failureCode, failedStage);
      clearWatchdog();
      const message = FAILURES[code] || FAILURES.runtime_error;
      if (loadingText) loadingText.textContent = message;
      if (status) status.textContent = code === 'not_configured' ? 'Point cloud unavailable' : 'Point cloud failed to load';
      loading?.classList.remove('hidden');
      loading?.classList.add('failed');
      if (retry) {
        retry.hidden = !retryable;
        retry.disabled = false;
      }
      notify('error', failureCode, failedStage);
    }

    function beginStartup() {
      arm('starting', timeouts.startup, 'startup_timeout', 'Starting point-cloud viewer…');
    }

    function beginLoad() {
      arm('loading-metadata', timeouts.load, 'load_timeout', 'Loading point-cloud metadata…');
    }

    function metadataReady() {
      diagnostic('metadata_ready');
      arm('loading-nodes', timeouts.nodes, 'node_timeout', 'Streaming point-cloud detail…');
      if (status) status.textContent = 'Point-cloud metadata ready; waiting for points…';
    }

    function pointsVisible() {
      // A large but healthy EPT may render its first node after the bounded
      // diagnostic watchdog. Recover from that one observational timeout when
      // Potree supplies positive evidence; all structural/runtime failures stay
      // terminal until an explicit retry.
      if (phase === 'access-required' || phase === 'ready' || (phase === 'failed' && failureCode !== 'node_timeout')) return;
      phase = 'ready';
      failureCode = null;
      diagnostic('points_visible', null, 'nodes');
      clearWatchdog();
      loading?.classList.add('hidden');
      loading?.classList.remove('failed');
      if (retry) retry.hidden = true;
      notify('ready', 'points_visible', 'nodes');
    }

    retry?.addEventListener('click', () => {
      if (phase !== 'failed') return;
      if (retry) retry.disabled = true;
      if (loadingText) loadingText.textContent = 'Retrying point cloud…';
      reload();
    });

    function accessRequired() {
      if (phase === 'access-required') return;
      phaseBeforeAccess = phase;
      const stage = stableStage();
      phase = 'access-required';
      clearWatchdog();
      if (status) status.textContent = 'Point cloud: renewing access…';
      if (phaseBeforeAccess !== 'ready') showLoading('Renewing point-cloud access…');
      notify('error', 'authorization_required', stage);
    }

    function accessRestored() {
      if (phase !== 'access-required') return;
      phase = phaseBeforeAccess;
      if (phase === 'ready') {
        if (status) status.textContent = 'Point cloud: access renewed';
        notify('ready', 'points_visible', 'nodes');
      } else if (phase === 'loading-nodes') metadataReady();
      else beginLoad();
    }

    function accessUnavailable() {
      phase = 'access-required';
      fail('authorization_unavailable', { retryable: false });
    }

    return { beginStartup, beginLoad, metadataReady, pointsVisible, fail,
      accessRequired, accessRestored, accessUnavailable, phase: () => phase };
  }

  return { FAILURES, createPointCloudHealth, hasVisiblePointCloudNodes };
}));
