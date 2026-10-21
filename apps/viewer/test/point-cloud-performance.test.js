const test = require('node:test');
const assert = require('node:assert/strict');
const { guardRendererResize, installViewerActivityGate, withPointPickCleanup, createFrameDiagnostics, createAdaptivePointBudget } = require('../public/pointcloud-performance.js');

test('adaptive diagnostics are opt-in, detached, bounded and preserve budget/FPS trajectories', () => {
  const plain = createAdaptivePointBudget(), observed = createAdaptivePointBudget();
  observed.setDiagnosticsEnabled(true);
  let time = 0;
  for (let i = 0; i < 4000; i++) {
    const dt = i < 200 ? 100 : i % 99 === 0 ? 120 : i % 800 > 700 ? 55 : 1000 / 33;
    const options = { minimum: 275000, demand: { pending: i % 91 === 0,
      drawnPoints: plain.state.live * 0.93, requiredPoints: Math.min(10000000, plain.state.live + 20000) } };
    time += dt;
    assert.equal(observed.sample(time, options), plain.sample(time, options));
    assert.equal(observed.fps(), plain.fps());
  }
  const snapshot = observed.snapshot();
  assert.ok(snapshot.lastDecision); assert.ok(snapshot.lastChange);
  assert.equal(Object.values(snapshot.lastDecision).some(Array.isArray), false);
  snapshot.lastDecision.reason = 'mutated'; snapshot.lastChange.after = -1; snapshot.live = -1;
  assert.notEqual(observed.snapshot().lastDecision.reason, 'mutated');
  assert.notEqual(observed.snapshot().lastChange.after, -1);
  assert.ok(observed.state.live > 0);
  assert.equal(plain.snapshot().lastDecision, null); assert.equal(plain.snapshot().lastChange, null);
  observed.setDiagnosticsEnabled(false);
  for (let i = 0; i < 100; i++) observed.sample(time += 40);
  assert.equal(observed.snapshot().lastDecision, null); assert.equal(observed.snapshot().lastChange, null);
});

test('adaptive diagnostics retain overload evidence while healthy dwell recovers', () => {
  const c = createAdaptivePointBudget(); c.setDiagnosticsEnabled(true);
  let time = 0;
  const step = dt => c.sample(time += dt, { minimum: 250000,
    demand: { pending: false, drawnPoints: c.state.live, requiredPoints: Math.min(10000000, c.state.live + 10000) } });
  for (let i = 0; i < 101; i++) step(100);
  assert.match(c.snapshot().lastDecision.reason, /overload/);
  for (let i = 0; i < 27; i++) step(40);
  const snapshot = c.snapshot();
  assert.equal(snapshot.lastDecision.reason, 'waiting for healthy frames');
  assert.ok(snapshot.lastDecision.capacityFrameMs <= 44);
  assert.ok(snapshot.lastDecision.healthyRemainingMs > 0);
  assert.ok(snapshot.lastChange.capacityFrameMs > 45);
  assert.equal(snapshot.lastChange.reason, 'overload reduction');
  assert.ok(snapshot.lastDecision.floor > 0);
  assert.equal(snapshot.lastDecision.canGrow, true);
});

test('rollback diagnostics immediately report the doubled healthy retry dwell', () => {
  const c = createAdaptivePointBudget(); c.setDiagnosticsEnabled(true);
  let time = 0;
  const step = dt => c.sample(time += dt, { minimum: 250000,
    demand: { pending: false, drawnPoints: c.state.live, requiredPoints: c.state.live + 10000 } });
  for (let i = 0; i < 201; i++) step(100);
  for (let i = 0; i < 200 && c.state.live === 250000; i++) step(40);
  assert.ok(c.state.live > 250000);
  for (let i = 0; i < 20 && c.state.live > 250000; i++) step(100);
  const decision = c.snapshot().lastDecision;
  assert.equal(decision.reason, 'probe rollback');
  assert.equal(decision.recoveryDelayMs, 8000);
  assert.equal(decision.recoveryWaitMs, 8000);
  assert.equal(decision.healthyRemainingMs, 8000);
});

test('refinement diagnostics distinguish known levels, pending work and a blocked budget without inferring source exhaustion', () => {
  const { refinementDiagnostics } = require('../public/pointcloud-performance.js');
  assert.deepEqual(refinementDiagnostics({}), { levels: 'unknown', childBranches: 0, nodePixelThreshold: null, pending: null, requiredPoints: null });
  const demand = Object.freeze({ pending: true, requiredPoints: 1234567 });
  const viewer = { minNodeSize: 30, scene: { pointclouds: [{ ltdsBudgetDemand: demand, visibleNodes: [
    { getLevel: () => 1, getChildren: () => [{}] },
    { getLevel: () => 7, getChildren: () => [] },
  ] }] } };
  assert.deepEqual(refinementDiagnostics(viewer), { levels: '1–7', childBranches: 1, nodePixelThreshold: 30, pending: true, requiredPoints: 1234567 });
  assert.equal(viewer.scene.pointclouds[0].ltdsBudgetDemand, demand);
});

test('opt-in CPU diagnostics have no off-path work and restore inherited and own methods', () => {
  let time = 0, reads = 0;
  const viewer = Object.create({ update(value) { assert.equal(this, viewer); time += value; return 'update'; } });
  viewer.renderer = { domElement: { width: 1200, height: 800 } };
  viewer.render = function () { assert.equal(this, viewer); time += 5; return 'render'; };
  const originalUpdate = viewer.update, originalRender = viewer.render;
  const diagnostics = createFrameDiagnostics(viewer, { now() { reads++; return time; } });
  assert.equal(diagnostics.enabled(), false);
  assert.equal(viewer.update, originalUpdate); assert.equal(viewer.render, originalRender);
  assert.equal(viewer.update(2), 'update'); assert.equal(viewer.render(), 'render');
  assert.equal(reads, 0);
  diagnostics.setEnabled(true); diagnostics.setEnabled(true);
  assert.equal(viewer.update(2), 'update'); assert.equal(viewer.render(), 'render');
  diagnostics.setEnabled(false);
  assert.equal(viewer.update, originalUpdate); assert.equal(viewer.render, originalRender);
  assert.equal(Object.hasOwn(viewer, 'update'), false);
  assert.equal(diagnostics.snapshot(), null);
  const readCount = reads; viewer.update(2); viewer.render(); assert.equal(reads, readCount);
});

test('CPU diagnostics publish bounded aggregates with submitted geometry and upload bytes', () => {
  let time = 0;
  const samples = [], geometry = { attributes: { position: { count: 3, array: new Float32Array(9) }, color: { array: new Uint8Array(12) } } };
  const node = { geometryNode: { geometry } };
  const pRenderer = {
    createBuffer(g) { assert.equal(g, geometry); assert.equal(this, pRenderer); time += 1; return 'buffer'; },
    updateBuffer(g) { assert.equal(g, geometry); time += 1; },
    renderNodes(cloud, nodes) { assert.equal(this, pRenderer); assert.equal(nodes[0], node); time += 3; },
  };
  const viewer = { pRenderer, renderer: { domElement: { width: 1200, height: 800 } },
    update() { time += 2; },
    render() { pRenderer.renderNodes({}, [node]); time += 2; },
  };
  const originalNodes = pRenderer.renderNodes, originalCreate = pRenderer.createBuffer;
  const d = createFrameDiagnostics(viewer, { now: () => time, onSample: sample => samples.push(sample) });
  d.setEnabled(true);
  assert.equal(pRenderer.createBuffer(geometry), 'buffer'); pRenderer.updateBuffer(geometry);
  for (let i = 0; i < 25; i++) { time = i * 50; viewer.update(); viewer.render(); }
  assert.equal(samples.length, 1);
  const sample = samples[0];
  assert.equal(sample.frameMs, 50); assert.equal(sample.maxFrameMs, 50);
  assert.equal(sample.updateMs, 2); assert.equal(sample.renderMs, 5); assert.equal(sample.pointRenderMs, 3);
  assert.equal(sample.uploads, 2); assert.equal(sample.uploadBytes, 96);
  assert.equal(sample.submittedNodes, 1); assert.equal(sample.submittedPoints, 3);
  assert.equal(sample.width, 1200); assert.equal(sample.height, 800);
  const copy = d.snapshot(); copy.renderMs = 999; assert.equal(d.snapshot().renderMs, 5);
  for (let i = 25; i < 50; i++) { time = i * 50; viewer.update(); viewer.render(); }
  assert.equal(samples.length, 2); assert.equal(samples[1].uploads, 0);
  d.setEnabled(false);
  assert.equal(pRenderer.renderNodes, originalNodes); assert.equal(pRenderer.createBuffer, originalCreate);
});

test('diagnostics exclude resume gaps and preserve original errors despite failed observers', () => {
  let time = 0;
  const viewer = { update() {}, render() {} };
  const d = createFrameDiagnostics(viewer, { now: () => time, onSample() { throw new Error('observer'); } });
  d.setEnabled(true); viewer.render(); time = 10_000;
  assert.doesNotThrow(() => viewer.render()); assert.equal(d.snapshot().frameMs, 0);
  d.setEnabled(false);
  const failure = new Error('render failed'); viewer.render = () => { throw failure; };
  d.setEnabled(true); time = 11_000;
  assert.throws(() => viewer.render(), error => error === failure);
  d.setEnabled(false);
});

test('point-cloud diagnostics are visible opt-in controls with no automatic activation', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/pointcloud.html'), 'utf8');
  assert.match(source, /id="pc-diagnostics-toggle"[^>]*aria-pressed="false"/);
  assert.match(source, /id="pc-diagnostics-output" hidden/);
  assert.match(source, /diagnosticsToggle\.addEventListener\('click'/);
  assert.doesNotMatch(source, /frameDiagnostics\.setEnabled\(true\)/);
});

test('native point picks restore materials and bound timing entries without adding success-path GPU resets', () => {
  let resets = 0; const cleared = [], material = {}, pointcloud = { material };
  const viewer = { renderer: { setRenderTarget() { resets++; }, state: { reset() { resets++; } }, setScissorTest() { resets++; } } };
  const timing = { measureTimings: false, performance: { clearMarks(name) { cleared.push(name); }, clearMeasures(name) { cleared.push(name); } } };
  const point = { position: [1, 2, 3] };
  assert.equal(withPointPickCleanup(pointcloud, viewer, timing, () => { pointcloud.material = {}; return point; }), point);
  assert.equal(pointcloud.material, material); assert.equal(resets, 0);
  assert.deepEqual(cleared, ['pick-start', 'pick-end', 'pick']);
  const failure = new Error('node disposed');
  assert.throws(() => withPointPickCleanup(pointcloud, viewer, timing, () => { pointcloud.material = {}; throw failure; }), error => error === failure);
  assert.equal(pointcloud.material, material); assert.equal(resets, 3); assert.equal(cleared.length, 6);
  timing.measureTimings = true;
  withPointPickCleanup(pointcloud, viewer, timing, () => point);
  assert.equal(cleared.length, 6);
});

test('hidden iframe schedules no Potree updates or renders and resumes without losing its view or assets', () => {
  let callback, active = true, clockResets = 0;
  const retainedCloud = { name: 'retained cloud' }, view = { yaw: 1.25 }, frames = [];
  const viewer = { scene: { pointclouds: [retainedCloud], view }, clock: { getDelta() { clockResets++; } },
    renderer: { xr: { isPresenting: false }, setAnimationLoop(fn) { callback = fn; } },
    loop(t, frame) { assert.equal(this, viewer); frames.push([t, frame]); },
  };
  assert.equal(installViewerActivityGate(viewer, { isActive: () => active }), true);
  callback(1);
  active = false;
  for (let i = 0; i < 60; i++) callback(i + 2);
  assert.deepEqual(frames, [[1, undefined]]);
  assert.equal(viewer.scene.pointclouds[0], retainedCloud);
  assert.equal(viewer.scene.view, view);
  active = true; callback(100);
  assert.equal(clockResets, 1);
  assert.equal(frames.length, 2);
  callback(101); assert.equal(clockResets, 1);
  active = false; viewer.renderer.xr.isPresenting = true;
  const xrFrame = {}; callback(102, xrFrame);
  assert.deepEqual(frames[3], [102, xrFrame]);
});

test('activity gate fails safely when a different renderer does not expose animation scheduling', () => {
  assert.equal(installViewerActivityGate({}, { isActive: () => true }), false);
});

test('camera overlay is submitted only when markers are visible and there is something to draw', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/pointcloud.html'), 'utf8');
  assert.match(source, /if \(pointCloudCameraLayer\.group\.visible && pointCloudCameraLayer\.drawnCount > 0\) \{\s*viewer\.renderer\.render\(cameraOverlayScene/);
  assert.match(source, /installViewerActivityGate\(viewer, \{\s*isActive: \(\) => !document\.hidden && viewer\.renderArea\.clientWidth > 0 && viewer\.renderArea\.clientHeight > 0/);
});

test('unchanged Potree frames avoid canvas buffer resets but preserve viewport; resize and DPR still work', () => {
  let resizes = 0, viewports = 0, ratio = 1;
  const renderer = { domElement: { style: {} }, xr: { isPresenting: false }, getPixelRatio: () => ratio,
    setViewport() { viewports++; },
    setSize(w, h) { if (this.xr.isPresenting) return; resizes++; this.domElement.width = Math.floor(w * ratio); this.domElement.height = Math.floor(h * ratio); this.setViewport(); },
  };
  guardRendererResize(renderer);
  for (let i = 0; i < 120; i++) renderer.setSize(800, 600);
  assert.equal(resizes, 1); assert.equal(viewports, 120);
  renderer.domElement.style.width = '10px'; renderer.setSize(800, 600);
  assert.equal(renderer.domElement.style.width, '800px'); assert.equal(resizes, 1);
  renderer.xr.isPresenting = true; renderer.setSize(800, 600); assert.equal(viewports, 121);
  renderer.xr.isPresenting = false; renderer.setSize(800, 600); assert.equal(resizes, 2);
  renderer.setSize(801, 600); assert.equal(resizes, 3);
  ratio = 2; renderer.setSize(801, 600); assert.equal(resizes, 4);
  renderer.setSize(801, 600, false); assert.equal(resizes, 5);
  renderer.domElement.width = 10; renderer.setSize(801, 600, false); assert.equal(resizes, 6);
});

function frames(controller, count, dt, options = {}) {
  for (let i = 0; i < count; i++) controller.sample(i * dt, options);
}

test('severe sustained frame time can reduce below the old 1.5M floor, retaining the root', () => {
  const c = createAdaptivePointBudget();
  frames(c, 100, 200, { minimum: 400_000 });
  assert.equal(c.state.live, 400_000);
  assert.equal(c.state.target, 10_000_000); assert.equal(c.state.auto, true);
});

test('background/throttled tabs and isolated stalls do not lower detail', () => {
  const c = createAdaptivePointBudget();
  frames(c, 50, 200, { active: false });
  c.sample(20_000); c.sample(22_000);
  assert.equal(c.state.live, c.state.target);
});

test('sustained extremely slow active frames still adapt', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 2000);
  assert.equal(c.state.live, 250_000);
});

test('late hierarchy metadata raises an adapted budget enough to draw the root', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  assert.equal(c.state.live, 250_000);
  c.sample(20_000, { minimum: 900_000 });
  assert.equal(c.state.live, 900_000);
});

test('growth requires sustained fast rendering and a populated scene; never exceeds requested budget', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  const low = c.state.live;
  frames(c, 1000, 16, { visiblePoints: 0 }); assert.equal(c.state.live, low);
  frames(c, 15000, 16, { visiblePoints: 10_000_000 }); assert.equal(c.state.live, c.state.target);
  c.setTarget(1_000_000); frames(c, 100, 200, { minimum: 2_000_000 });
  assert.equal(c.state.live, 1_000_000);
  c.setTarget(NaN); assert.equal(c.state.target, 1_000_000);
});

test('density recovers after transient load at a stable 23, 25, or 30 FPS without requiring 45 FPS', () => {
  for (const fps of [23, 25, 30]) {
    const c = createAdaptivePointBudget(); frames(c, 100, 200);
    assert.equal(c.state.live, 250_000);
    let time = 20_000;
    const dt = 1000 / fps;
    for (let i = 0; i < fps * 150; i++) {
      time += dt; c.sample(time, { visiblePoints: c.state.live });
    }
    assert.equal(c.state.live, c.state.target, `${fps} FPS must be allowed to recover density`);
  }
});

test('a density probe which actually overloads the device rolls back and backs off rather than forcing full detail', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  const base = c.state.live;
  let time = 20_000, probes = [], previous = base, maximum = base;
  while (time < 200_000) {
    // This synthetic device supports the base at 25 FPS; extra points genuinely
    // overload it. A probe must not cause continuing budget oscillation.
    time += c.state.live > base ? 100 : 40;
    c.sample(time, { visiblePoints: c.state.live });
    if (c.state.live > previous) probes.push(time);
    maximum = Math.max(maximum, c.state.live); previous = c.state.live;
  }
  assert.ok(probes.length >= 4 && probes.length <= 7, `bounded retries: ${probes.length}`);
  assert.ok(probes[2] - probes[1] > probes[1] - probes[0], 'failed probes back off');
  assert.ok(probes.at(-1) - probes.at(-2) >= 60_000, 'retry delay is capped at one minute');
  assert.equal(maximum, Math.ceil(base * 1.15));
  assert.equal(c.state.live, base);
});

test('empty scenes, sustained overload, and explicit lower targets still constrain recovery', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  let time = 20_000;
  for (let i = 0; i < 3000; i++) { time += 40; c.sample(time, { visiblePoints: 0 }); }
  assert.equal(c.state.live, 250_000);
  for (let i = 0; i < 3000; i++) { time += 80; c.sample(time, { visiblePoints: c.state.live }); }
  assert.equal(c.state.live, 250_000);
  c.setTarget(500_000);
  for (let i = 0; i < 3000; i++) { time += 40; c.sample(time, { visiblePoints: c.state.live }); }
  assert.equal(c.state.live, 500_000);
});

test('settled underfilled additive frontier probes enough budget for real blocked detail then stops', () => {
  const c=createAdaptivePointBudget();frames(c,100,200);let time=20_000;
  for(let i=0;i<36000;i++){
    const fits=c.state.live>=275000;
    c.sample(time+=1000/60,{visiblePoints:fits?275000:100000,demand:{requiredPoints:fits?0:275000,drawnPoints:fits?275000:100000,pending:false}});
  }
  assert.equal(c.state.live,287500,'one bounded 15% probe admits the next 175k node after the 100k ancestor');
  assert.equal(c.state.target,10000000);
});

test('demand-aware probing excludes empty/loading/no-demand scenes and unreachable targets', () => {
  for(const demand of [
    {requiredPoints:275000,drawnPoints:0,pending:false},
    {requiredPoints:275000,drawnPoints:100000,pending:true},
    {requiredPoints:0,drawnPoints:250000,pending:false},
    {requiredPoints:11000000,drawnPoints:100000,pending:false},
  ]){
    const c=createAdaptivePointBudget();frames(c,100,200);let time=20000;
    for(let i=0;i<4000;i++)c.sample(time+=16.667,{visiblePoints:250000,demand});
    assert.equal(c.state.live,250000);
  }
});

test('underfilled demand probe retains overload rollback and bounded retry backoff', () => {
  const c=createAdaptivePointBudget();frames(c,100,200);let time=20000,previous=c.state.live;const probes=[];
  while(time<200000){
    const fits=c.state.live>=275000;
    c.sample(time+=fits?100:40,{visiblePoints:fits?275000:100000,demand:{requiredPoints:fits?0:275000,drawnPoints:fits?275000:100000,pending:false}});
    if(c.state.live>previous)probes.push(time);previous=c.state.live;
  }
  assert.equal(c.state.live,250000);assert.ok(probes.length>=4&&probes.length<=7);
  assert.ok(probes.at(-1)-probes.at(-2)>=60000);
});

test('a settled 43-FPS 375k frontier recovers useful zoom detail promptly without changing the 10M request', () => {
  const c=createAdaptivePointBudget(); frames(c,100,200); let time=20000;
  for(let i=0;i<43*25;i++) {
    const live=c.state.live;
    c.sample(time+=1000/43,{minimum:375000,visiblePoints:live*0.94,demand:{pending:false,drawnPoints:live*0.94,requiredPoints:Math.min(10000000,live+100000)}});
    assert.ok(c.state.live<=10000000);
    if(i===43*12) assert.ok(c.state.live>=2000000,'close-view detail must not spend a minute near the sparse floor');
  }
  assert.equal(c.state.live,10000000);
  assert.equal(c.state.target,10000000);
});

test('fast density recovery rolls back and backs off if the extra detail actually overloads rendering', () => {
  const c=createAdaptivePointBudget(); frames(c,100,200); let time=20000,previous=375000;
  const probes=[]; let maximum=0;
  while(time<200000) {
    const live=c.state.live;
    c.sample(time+=live>375000?100:1000/43,{minimum:375000,visiblePoints:live,demand:{pending:false,drawnPoints:live,requiredPoints:live+100000}});
    if(c.state.live>previous) probes.push(time);
    maximum=Math.max(maximum,c.state.live); previous=c.state.live;
  }
  assert.equal(c.state.live,375000);
  assert.equal(maximum,562500,'fast recovery remains a bounded 50% trial, not a jump to 10M');
  assert.ok(probes.length>=4&&probes.length<=7);
  assert.ok(probes.at(-1)-probes.at(-2)>=60000,'fast path must not bypass failed-probe backoff');
});

test('33-FPS recovery is not starved by one 120ms frame every three seconds', () => {
  const c=createAdaptivePointBudget(); frames(c,100,200); let time=20000;
  for(let i=1;i<=33*120;i++) {
    const live=c.state.live;
    c.sample(time+=i%99===0?120:1000/33,{minimum:375000,visiblePoints:live*0.93,demand:{pending:false,drawnPoints:live*0.93,requiredPoints:Math.min(10000000,live+20000)}});
    if(i===33*20)assert.ok(c.state.live>375000,'periodic moderate stalls must not trap a healthy view at its sparse floor');
    assert.ok(c.state.live<=10000000);
  }
  assert.equal(c.state.live,10000000);
  assert.equal(c.state.target,10000000);
});

test('bounded windows still reduce sustained slow frames and repeated stall-heavy frames', () => {
  for(const cadence of [[50],[100],[30,30,120],[30,30,30,250]]) {
    const c=createAdaptivePointBudget(); let time=0;
    for(let i=0;i<900;i++)c.sample(time+=cadence[i%cadence.length],{minimum:375000,visiblePoints:c.state.live,demand:{pending:false,drawnPoints:c.state.live,requiredPoints:Math.min(10000000,c.state.live+20000)}});
    assert.equal(c.state.live,375000,`overload cadence ${cadence} must retain the safe root floor`);
    assert.equal(c.state.target,10000000);
  }
});
