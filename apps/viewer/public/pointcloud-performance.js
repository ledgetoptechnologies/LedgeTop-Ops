(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudPerformance = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Potree calls setSize on every frame. Its pinned Three version assigns
  // canvas.width/height even when unchanged, resetting the drawing buffer.
  // Preserve setSize's viewport reset, but only resize the canvas on change.
  function guardRendererResize(renderer) {
    const original = renderer.setSize;
    let previous = null;
    renderer.setSize = function (width, height, updateStyle) {
      if (this.xr?.isPresenting) { previous = null; return original.call(this, width, height, updateStyle); }
      const ratio = this.getPixelRatio();
      const canvas = this.domElement;
      if (previous && previous.width === width && previous.height === height &&
          previous.ratio === ratio && previous.style === updateStyle &&
          canvas.width === Math.floor(width * ratio) && canvas.height === Math.floor(height * ratio)) {
        if (updateStyle !== false && canvas.style) {
          if (canvas.style.width !== width + 'px') canvas.style.width = width + 'px';
          if (canvas.style.height !== height + 'px') canvas.style.height = height + 'px';
        }
        this.setViewport(0, 0, width, height);
        return;
      }
      const result = original.call(this, width, height, updateStyle);
      previous = { width, height, ratio, style: updateStyle };
      return result;
    };
  }

  // Potree owns a Three animation loop which keeps updating visibility and
  // submitting GPU work when its iframe is display:none in the parent page.
  // Retain the loaded cloud/view, but run no frame work until it is visible.
  // Do not stop the animation scheduler: visibility must resume automatically.
  function installViewerActivityGate(viewer, { isActive }) {
    if (typeof viewer?.loop !== 'function' || typeof viewer?.renderer?.setAnimationLoop !== 'function') return false;
    let suspended = false;
    const loop = viewer.loop.bind(viewer);
    viewer.renderer.setAnimationLoop(function (timestamp, frame) {
      // Preserve Three's XR scheduling semantics even if the page is hidden.
      if (!viewer.renderer.xr?.isPresenting && !isActive()) {
        suspended = true;
        return;
      }
      if (suspended) {
        // A hidden minute must not advance controls/animations by a minute.
        viewer.clock?.getDelta?.();
        suspended = false;
      }
      return loop(timestamp, frame);
    });
    return true;
  }

  function withPointPickCleanup(pointcloud, viewer, timing, pick) {
    const material = pointcloud.material;
    try {
      return pick();
    } catch (error) {
      // The pinned picker restores these on success, but can throw while a
      // streamed node is being disposed. Do not leave its pick material active.
      viewer.renderer.setRenderTarget(null);
      viewer.renderer.state.reset();
      viewer.renderer.setScissorTest(false);
      throw error;
    } finally {
      pointcloud.material = material;
      // Potree appends pick timing entries even when profiling is disabled.
      // Bound ordinary navigation history while retaining explicit profiling.
      if (!timing.measureTimings) {
        timing.performance.clearMarks('pick-start');
        timing.performance.clearMarks('pick-end');
        timing.performance.clearMeasures('pick');
      }
    }
  }

  // Opt-in, application-side CPU measurements only. No GPU queries/readback,
  // User Timing entries, history arrays, polling timers, or network telemetry.
  // Disabling restores the exact original methods: no per-frame off-path cost.
  function createFrameDiagnostics(viewer, { now = () => performance.now(), onSample = () => {} } = {}) {
    let enabled = false, restorers = [], windowStart = 0, previousFrame = null;
    let totals, latest = null;
    function reset() {
      totals = { frames: 0, updates: 0, updateMs: 0, renderMs: 0, pointRenderMs: 0,
        cadenceMs: 0, cadenceSamples: 0, maxFrameMs: 0, uploads: 0, uploadBytes: 0,
        submittedNodes: 0, submittedPoints: 0 };
    }
    function wrap(object, name, instrument) {
      if (typeof object?.[name] !== 'function') return;
      const own = Object.prototype.hasOwnProperty.call(object, name), original = object[name];
      const wrapped = function (...args) { return instrument.call(this, original, args); };
      object[name] = wrapped;
      restorers.push(() => {
        // Do not overwrite another owner's newer instrumentation.
        if (object[name] !== wrapped) return;
        if (own) object[name] = original;
        else delete object[name];
      });
    }
    function publish(time) {
      if (time - windowStart < 1000) return;
      const frames = Math.max(1, totals.frames);
      const canvas = viewer.renderer?.domElement;
      latest = {
        frames: totals.frames,
        frameMs: totals.cadenceSamples ? totals.cadenceMs / totals.cadenceSamples : 0,
        maxFrameMs: totals.maxFrameMs,
        updateMs: totals.updateMs / Math.max(1, totals.updates),
        renderMs: totals.renderMs / frames,
        pointRenderMs: totals.pointRenderMs / frames,
        uploads: totals.uploads, uploadBytes: totals.uploadBytes,
        submittedNodes: totals.submittedNodes / frames,
        submittedPoints: totals.submittedPoints / frames,
        width: Number(canvas?.width) || 0, height: Number(canvas?.height) || 0,
      };
      reset(); windowStart = time;
      // A diagnostics display failure must never interrupt the render loop.
      try { onSample({ ...latest }); } catch { /* diagnostic observer only */ }
    }
    return {
      enabled: () => enabled,
      snapshot: () => latest ? { ...latest } : null,
      setEnabled(value) {
        value = !!value;
        if (value === enabled) return;
        enabled = value;
        if (!value) {
          for (const restore of restorers.reverse()) restore();
          restorers = []; latest = null; previousFrame = null;
          return;
        }
        reset(); windowStart = now(); previousFrame = null;
        wrap(viewer, 'update', function (original, args) {
          const start = now();
          try { return original.apply(this, args); }
          finally { totals.updateMs += now() - start; totals.updates++; }
        });
        wrap(viewer, 'render', function (original, args) {
          const start = now();
          if (previousFrame !== null) {
            const cadence = start - previousFrame;
            // Hidden-tab/resume gaps are not active rendering cost.
            if (cadence >= 0 && cadence <= 1000) {
              totals.cadenceMs += cadence; totals.cadenceSamples++;
              totals.maxFrameMs = Math.max(totals.maxFrameMs, cadence);
            }
          }
          previousFrame = start;
          try { return original.apply(this, args); }
          finally { const end = now(); totals.renderMs += end - start; totals.frames++; publish(end); }
        });
        wrap(viewer.pRenderer, 'renderNodes', function (original, args) {
          const nodes = args[1] || [];
          totals.submittedNodes += nodes.length;
          for (const node of nodes) {
            totals.submittedPoints += Number(node.geometryNode?.geometry?.attributes?.position?.count) || 0;
          }
          const start = now();
          try { return original.apply(this, args); }
          finally { totals.pointRenderMs += now() - start; }
        });
        for (const name of ['createBuffer', 'updateBuffer']) {
          wrap(viewer.pRenderer, name, function (original, args) {
            totals.uploads++;
            for (const attribute of Object.values(args[0]?.attributes || {})) {
              totals.uploadBytes += Number(attribute.array?.byteLength) || 0;
            }
            return original.apply(this, args);
          });
        }
      },
    };
  }

  function createAdaptivePointBudget(initialTarget = 10_000_000) {
    const state = { target: initialTarget, live: initialTarget, auto: false, points: 0 };
    let frameMs = 1000 / 60, lastFrame = null, samples = 0, elapsed = 0, healthyMs = 0, longFrames = 0;
    let probeBase = null, probeAgeMs = 0, recoveryDelayMs = 4000;
    // Two bounded records, updated at capacity decisions (not a frame history).
    // Snapshot consumers cannot mutate the controller or retained records.
    let lastDecision = null, lastChange = null, diagnosticsEnabled = false;
    function resetTiming() { lastFrame = null; samples = 0; elapsed = 0; healthyMs = 0; }
    return {
      state,
      fps: () => 1000 / frameMs,
      setDiagnosticsEnabled(value) {
        diagnosticsEnabled = !!value;
        if (!diagnosticsEnabled) { lastDecision = null; lastChange = null; }
      },
      snapshot: () => ({ target: state.target, live: state.live,
        lastDecision: lastDecision ? { ...lastDecision } : null,
        lastChange: lastChange ? { ...lastChange } : null }),
      setTarget(value) {
        if (!Number.isFinite(value) || value <= 0) return state.live;
        const before = state.live;
        state.target = state.live = Math.round(value);
        lastDecision = null;
        if (diagnosticsEnabled) lastChange = { reason: 'requested target', before, after: state.live, time: null };
        state.auto = false;
        probeBase = null; probeAgeMs = 0; recoveryDelayMs = 4000;
        resetTiming();
        return state.live;
      },
      sample(time, { active = true, minimum = 250_000, visiblePoints = state.points, demand = null } = {}) {
        if (!active || !Number.isFinite(time)) { longFrames = 0; resetTiming(); return state.live; }
        const floor = Math.min(state.target, Math.max(250_000, Number.isFinite(minimum) ? minimum : 250_000));
        // Hierarchy metadata may arrive after the budget has already adapted.
        // Keep the root drawable, without overriding the user's requested ceiling.
        if (state.live < floor) {
          if (diagnosticsEnabled) lastChange = { reason: 'root floor', before: state.live, after: floor, time };
          state.live = floor;
        }
        state.auto = state.live < state.target;
        if (lastFrame === null) { lastFrame = time; return state.live; }
        let dt = time - lastFrame;
        lastFrame = time;
        // Ignore one isolated stall; sustained active <1-FPS rendering must
        // still adapt. Hidden views are excluded by the caller above.
        if (dt <= 0) { resetTiming(); return state.live; }
        longFrames = dt > 1000 ? longFrames + 1 : 0;
        if (longFrames === 1) { samples = 0; elapsed = 0; healthyMs = 0; return state.live; }
        dt = Math.min(1000, dt);
        frameMs += (dt - frameMs) * (1 - Math.exp(-dt / 350));
        samples++; elapsed += dt;
        // Keep the responsive EMA for the displayed FPS, but make capacity
        // decisions from bounded frame windows. A single 120ms decode/GC frame
        // every three seconds must not erase otherwise healthy 33-FPS recovery
        // forever. Every frame still contributes: sustained or frequent stalls
        // raise the window average and retain the overload safeguards below.
        if (samples < 8 || elapsed < 1000) return state.live;
        const windowMs = elapsed, capacityFrameMs = elapsed / samples;
        elapsed = 0; samples = 0;
        healthyMs = capacityFrameMs <= 44 ? healthyMs + windowMs : 0;
        // Whole additive nodes may not fit the remaining budget even when the
        // scene occupies less than 70% of it. Probe only confirmed eligible
        // demand with settled drawn ancestors, never an empty/loading scene.
        const settledDemand = demand && demand.pending === false && Number.isFinite(demand.drawnPoints) && demand.drawnPoints > 0;
        const canGrow = demand ? settledDemand && Number.isFinite(demand.requiredPoints) && demand.requiredPoints > state.live && demand.requiredPoints <= state.target : visiblePoints >= state.live * 0.7;
        const probeSettled = demand ? settledDemand : visiblePoints >= state.live * 0.7;
        // After a transient upload/decoder stall, +15% every four seconds can
        // leave a healthy 43-FPS view at ~0.4M for over a minute despite a 10M
        // request. Recover faster only with measured headroom, settled drawn
        // detail filling the live cap, and an eligible blocked frontier.
        // Failed probes still honor the existing exponential retry backoff.
        const fastRecovery = capacityFrameMs <= 30 && settledDemand && demand.drawnPoints >= state.live * 0.7;
        const recoveryWait = fastRecovery && recoveryDelayMs === 4000 ? 2000 : recoveryDelayMs;
        const before = state.live;
        let reason = 'waiting for healthy frames';
        if (probeBase !== null) {
          probeAgeMs += windowMs;
          if (probeAgeMs >= 2000 && capacityFrameMs <= 45 && probeSettled) {
            probeBase = null; recoveryDelayMs = 4000;
          }
        }
        if (capacityFrameMs > 45 && state.live > floor) {
          if (probeBase !== null) {
            // An unsuccessful probe rolls back exactly once, then backs off
            // 8/16/32/60s. Do not oscillate continuously on an overloaded GPU.
            state.live = Math.max(floor, probeBase);
            recoveryDelayMs = Math.min(60000, recoveryDelayMs * 2);
            probeBase = null;
            reason = 'probe rollback';
          } else {
            state.live = Math.max(floor, Math.floor(state.live * (capacityFrameMs > 90 ? 0.5 : 0.75)));
            reason = 'overload reduction';
          }
          elapsed = 0; samples = 0; healthyMs = 0;
        } else if (probeBase === null && healthyMs >= recoveryWait && canGrow && state.live < state.target) {
          // Do not mistake an almost-empty/loading scene for capacity to draw more.
          probeBase = state.live; probeAgeMs = 0;
          state.live = Math.min(state.target, Math.ceil(state.live * (fastRecovery ? 1.5 : 1.15)));
          reason = fastRecovery ? 'fast recovery probe' : 'recovery probe';
          elapsed = 0; samples = 0; healthyMs = 0;
        } else if (capacityFrameMs > 45) {
          reason = 'overload at floor';
        } else if (state.live >= state.target) {
          reason = 'requested ceiling';
        } else if (probeBase !== null) {
          reason = 'observing probe';
        } else if (!canGrow) {
          reason = demand?.pending ? 'selected detail pending' : !probeSettled ? 'no settled drawn detail' : 'no eligible frontier';
        } else if (recoveryDelayMs > 4000) {
          reason = 'probe backoff';
        }
        if (diagnosticsEnabled) {
          const diagnosticWait = fastRecovery && recoveryDelayMs === 4000 ? 2000 : recoveryDelayMs;
          lastDecision = { time, capacityFrameMs, windowMs, reason, before, after: state.live, floor,
          requiredPoints: Number.isFinite(demand?.requiredPoints) ? demand.requiredPoints : null,
          drawnPoints: Number.isFinite(demand?.drawnPoints) ? demand.drawnPoints : visiblePoints,
          pending: demand ? demand.pending === true : null, canGrow: !!canGrow,
          healthyMs, recoveryDelayMs, recoveryWaitMs: diagnosticWait,
          healthyRemainingMs: Math.max(0, diagnosticWait - healthyMs), probeBase, probeAgeMs };
          if (before !== state.live) lastChange = { ...lastDecision };
        }
        state.auto = state.live < state.target;
        return state.live;
      },
    };
  }
  // Read only, requested once per opt-in diagnostic sample. No GPU readback,
  // hierarchy loads, point-budget changes or claims that unknown leaves are
  // the source's full resolution.
  function refinementDiagnostics(viewer) {
    const cloud = viewer?.scene?.pointclouds?.[0];
    let minLevel = Infinity, maxLevel = -Infinity, childBranches = 0;
    for (const node of cloud?.visibleNodes || []) {
      const level = node.getLevel?.();
      if (Number.isFinite(level)) { minLevel = Math.min(minLevel, level); maxLevel = Math.max(maxLevel, level); }
      if (node.getChildren?.().length) childBranches++;
    }
    const demand = cloud?.ltdsBudgetDemand;
    return {
      levels: Number.isFinite(minLevel) ? `${minLevel}–${maxLevel}` : 'unknown',
      childBranches,
      nodePixelThreshold: Number.isFinite(viewer?.minNodeSize) ? viewer.minNodeSize : null,
      pending: demand ? demand.pending === true : null,
      requiredPoints: Number.isFinite(demand?.requiredPoints) && demand.requiredPoints > 0 ? demand.requiredPoints : null,
    };
  }
  return { guardRendererResize, installViewerActivityGate, withPointPickCleanup, createFrameDiagnostics, createAdaptivePointBudget, refinementDiagnostics };
}));
