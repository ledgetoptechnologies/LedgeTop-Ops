(function pointCloudCameraModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudCameras = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPointCloudCameraModule() {
  const CAMERA_MARKER_COLORS = Object.freeze({
    body: 0xD8DEE6,
    face: 0xEE5007,
    cue: 0xF8CB2E,
    tab: 0xEE5007,
  });

  const CAMERA_MARKER_OPACITY = Object.freeze({ normal: 0.82, hover: 1 });
  const DEFAULT_CAMERA_MARKER_SCALE = 0.5;
  const CAMERA_MARKER_STYLE = Object.freeze({ width: Math.hypot(1.48, 1.13, 0.42), maxPixels: 10, maxVisible: Infinity, pickRadius: 12 });
  const CAMERA_MARKER_COMPONENTS = Object.freeze(['body', 'face', 'cue', 'tab']);

  function cameraMarkerScaleForView({ baseScale = DEFAULT_CAMERA_MARKER_SCALE } = {}) {
    const parsed = Number(baseScale);
    const requested = Number.isFinite(parsed) ? parsed : DEFAULT_CAMERA_MARKER_SCALE;
    return Math.max(0.1, Math.min(4, requested));
  }

  function selectCameraMarkerRepresentatives(candidates, { width, height, maxVisible = CAMERA_MARKER_STYLE.maxVisible, margin = CAMERA_MARKER_STYLE.maxPixels } = {}) {
    const viewportWidth = Number(width), viewportHeight = Number(height);
    const limit = Math.max(0, Math.floor(Number(maxVisible)) || 0);
    const viewportMargin = Math.max(0, Number(margin) || 0);
    if (!Array.isArray(candidates) || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
      || viewportWidth <= 0 || viewportHeight <= 0 || limit === 0) return [];
    // Match the model: retain real source identities, even when they overlap.
    const sources = new Set();
    for (const candidate of candidates) {
      const index = Number(candidate?.index), x = Number(candidate?.x), y = Number(candidate?.y), depth = Number(candidate?.depth);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(x) || !Number.isFinite(y)
        || !Number.isFinite(depth) || depth <= 0
        || x < -viewportMargin || x > viewportWidth + viewportMargin
        || y < -viewportMargin || y > viewportHeight + viewportMargin) continue;
      sources.add(index);
    }
    return [...sources].sort((left, right) => left - right).slice(0, limit);
  }

  function pushTriangle(target, a, b, c) { target.push(...a, ...b, ...c); }
  function pushQuad(target, a, b, c, d) {
    pushTriangle(target, a, b, c);
    pushTriangle(target, a, c, d);
  }
  function pushBox(target, minX, maxX, minY, maxY, minZ, maxZ) {
    const nnn = [minX, minY, minZ], pnn = [maxX, minY, minZ];
    const ppn = [maxX, maxY, minZ], npn = [minX, maxY, minZ];
    const nnp = [minX, minY, maxZ], pnp = [maxX, minY, maxZ];
    const ppp = [maxX, maxY, maxZ], npp = [minX, maxY, maxZ];
    pushQuad(target, nnn, npn, ppn, pnn);
    pushQuad(target, nnp, pnp, ppp, npp);
    pushQuad(target, nnn, nnp, npp, npn);
    pushQuad(target, pnn, ppn, ppp, pnp);
    pushQuad(target, npn, npp, ppp, ppn);
    pushQuad(target, nnn, pnn, pnp, nnp);
  }
  function pushFrustumShell(target, { backX, backY, backZ, frontX, frontY, frontZ, caps = false }) {
    const back = [[-backX,-backY,backZ],[backX,-backY,backZ],[backX,backY,backZ],[-backX,backY,backZ]];
    const front = [[-frontX,-frontY,frontZ],[frontX,-frontY,frontZ],[frontX,frontY,frontZ],[-frontX,frontY,frontZ]];
    for (let index = 0; index < 4; index += 1) {
      const next = (index + 1) % 4;
      pushQuad(target, back[index], back[next], front[next], front[index]);
    }
    if (caps) {
      pushQuad(target, back[0], back[3], back[2], back[1]);
      pushQuad(target, front[0], front[1], front[2], front[3]);
    }
  }
  function pushDisc(target, centerX, centerY, z, radius, segments = 8) {
    for (let index = 0; index < segments; index += 1) {
      const angle0 = index / segments * Math.PI * 2;
      const angle1 = (index + 1) / segments * Math.PI * 2;
      pushTriangle(target,
        [centerX, centerY, z],
        [centerX + Math.cos(angle0) * radius, centerY + Math.sin(angle0) * radius, z],
        [centerX + Math.cos(angle1) * radius, centerY + Math.sin(angle1) * radius, z]);
    }
  }

  function cameraMarkerGeometryData() {
    // OpenSfM: +Y is image-down and +Z forward. The tab follows -Y/image-up
    // through the original shot rotation, including upside-down captures.
    const body = [];
    pushFrustumShell(body, { backX:0.74, backY:0.48, backZ:-0.26, frontX:0.58, frontY:0.40, frontZ:0.12 });
    pushBox(body, -0.74, -0.64, -0.48, 0.48, -0.26, -0.20);
    pushBox(body, 0.64, 0.74, -0.48, 0.48, -0.26, -0.20);
    pushBox(body, -0.64, 0.64, -0.48, -0.38, -0.26, -0.20);
    pushBox(body, -0.64, 0.64, 0.38, 0.48, -0.26, -0.20);
    pushQuad(body, [-0.58,-0.40,0.12],[0.58,-0.40,0.12],[0.58,0.40,0.12],[-0.58,0.40,0.12]);
    const face = [];
    pushQuad(face, [-0.64,-0.38,-0.27],[-0.64,0.38,-0.27],[0.64,0.38,-0.27],[0.64,-0.38,-0.27]);
    const cue = [];
    pushDisc(cue, 0, 0, 0.15, 0.24);
    const tab = [];
    pushBox(tab, 0.40, 0.60, -0.65, -0.46, -0.25, -0.10);
    return { body, face, cue, tab };
  }

  function normalizeCameraMarkers(value) {
    if (!Array.isArray(value) || value.length > 100_000) return [];
    const markers = [];
    for (const marker of value) {
      const translation = marker?.translation;
      const rotation = marker?.rotation;
      if (!Array.isArray(translation) || translation.length !== 3
        || !Array.isArray(rotation) || rotation.length !== 3
        || !translation.every(Number.isFinite) || !rotation.every(Number.isFinite)) continue;
      markers.push({ translation: translation.slice(), rotation: rotation.slice() });
    }
    return markers;
  }

  function cameraMarkerLocalFrame(value) {
    const markers = normalizeCameraMarkers(value);
    if (!markers.length) return { origin: [0, 0, 0], markers: [] };
    const origin = markers[0].translation.slice();
    return {
      origin,
      markers: markers.map((marker) => ({
        translation: marker.translation.map((coordinate, index) => coordinate - origin[index]),
        rotation: marker.rotation.slice(),
      })),
    };
  }

  function createCameraClickTracker({ threshold = 5 } = {}) {
    const limit = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : 5;
    const pointers = new Set();
    let start = null;
    function pointerDown(event) {
      pointers.add(event.pointerId);
      if (event.button !== 0 || pointers.size !== 1 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        start = null;
        return;
      }
      start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }
    function pointerMove(event) {
      if (start?.pointerId === event.pointerId
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= limit) start = null;
    }
    function pointerUp(event) {
      const candidate = start;
      pointers.delete(event.pointerId);
      start = null;
      if (!candidate || candidate.pointerId !== event.pointerId || event.button !== 0
        || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
        || Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) >= limit) return null;
      return { x: event.clientX, y: event.clientY };
    }
    function pointerCancel(event) {
      pointers.delete(event.pointerId);
      start = null;
    }
    return Object.freeze({ pointerDown, pointerMove, pointerUp, pointerCancel });
  }

  function canPickCameraHover(event, controls, insertion) {
    return !event.buttons && event.pointerType !== 'touch'
      && controls?._mode === 'none' && !controls?._inertia?.active
      && (!controls?._touch?.mode || controls._touch.mode === 'none')
      && !insertion?.m && !insertion?.v;
  }

  function createPointCloudCameraLayer({ THREE, scene, dom, getCamera }) {
    if (!THREE?.InstancedMesh || !scene?.add || !dom?.getBoundingClientRect || typeof getCamera !== 'function') {
      throw new TypeError('invalid point-cloud camera layer dependencies');
    }
    const group = new THREE.Group();
    group.name = 'ltds-camera-positions';
    group.visible = false;
    scene.add(group);
    const raycaster = new THREE.Raycaster();
    let componentMeshes = [];
    let scale = DEFAULT_CAMERA_MARKER_SCALE;
    let markerWorldPositions = null;
    let markerLocalPositions = null;
    let markerQuaternions = null;
    let markerDepths = null;
    let drawToSource = [];
    let sourceToDraw = null;
    let hoveredSource = -1;
    let scaleSignature = '';
    let scaleUpdatedAt = 0;

    function disposeMeshes() {
      for (const mesh of componentMeshes) {
        if (!mesh) continue;
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      componentMeshes = [];
      markerWorldPositions = null;
      markerLocalPositions = null;
      markerQuaternions = null;
      markerDepths = null;
      drawToSource = [];
      sourceToDraw = null;
      hoveredSource = -1;
      scaleSignature = '';
    }

    function geometry(positions) {
      const value = new THREE.BufferGeometry();
      value.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      value.computeVertexNormals();
      return value;
    }

    function setMarkers(value) {
      const frame = cameraMarkerLocalFrame(value);
      const markers = frame.markers;
      disposeMeshes();
      group.position.set(frame.origin[0], frame.origin[1], frame.origin[2]);
      if (!markers.length) return 0;
      markerWorldPositions = new Float64Array(markers.length * 3);
      markerLocalPositions = new Float64Array(markers.length * 3);
      markerQuaternions = new Float32Array(markers.length * 4);
      markerDepths = new Float64Array(markers.length);
      sourceToDraw = new Int32Array(markers.length);
      sourceToDraw.fill(-1);
      const data = cameraMarkerGeometryData();
      const material = () => new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: CAMERA_MARKER_OPACITY.normal,
        side: THREE.FrontSide,
        depthTest: false,
        depthWrite: false,
      });
      componentMeshes = CAMERA_MARKER_COMPONENTS.map((component, index) => {
        const mesh = new THREE.InstancedMesh(geometry(data[component]), material(), markers.length);
        mesh.userData.cameraMarkerComponent = component;
        mesh.frustumCulled = false;
        mesh.renderOrder = index;
        return mesh;
      });
      const quaternion = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      markers.forEach((marker, index) => {
        const r = marker.rotation;
        const angle = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        if (angle > 1e-9) axis.set(-r[0] / angle, -r[1] / angle, -r[2] / angle);
        else axis.set(0, 0, 1);
        quaternion.setFromAxisAngle(axis, angle);
        markerLocalPositions[index * 3] = marker.translation[0];
        markerLocalPositions[index * 3 + 1] = marker.translation[1];
        markerLocalPositions[index * 3 + 2] = marker.translation[2];
        markerQuaternions[index * 4] = quaternion.x;
        markerQuaternions[index * 4 + 1] = quaternion.y;
        markerQuaternions[index * 4 + 2] = quaternion.z;
        markerQuaternions[index * 4 + 3] = quaternion.w;
        markerWorldPositions[index * 3] = frame.origin[0] + marker.translation[0];
        markerWorldPositions[index * 3 + 1] = frame.origin[1] + marker.translation[1];
        markerWorldPositions[index * 3 + 2] = frame.origin[2] + marker.translation[2];
      });
      componentMeshes.forEach((mesh) => {
        mesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS[mesh.userData.cameraMarkerComponent]));
        mesh.count = 0;
      });
      group.add(...componentMeshes);
      updateView(true);
      return markers.length;
    }

    function setScale(value) {
      scale = cameraMarkerScaleForView({ baseScale: value });
      updateView(true);
    }

    function updateView(force = false) {
      // Hidden cameras retain their source data, but must not project every
      // shot or upload instance buffers as the point-cloud camera moves.
      // setVisible(true) forces a fresh update at the current viewpoint.
      if (!group.visible) return false;
      if (componentMeshes.length !== CAMERA_MARKER_COMPONENTS.length || !markerWorldPositions || !markerLocalPositions || !markerQuaternions) return false;
      const camera = getCamera();
      const rect = dom.getBoundingClientRect();
      if (!camera || !rect.width || !rect.height) return false;
      const now = performance.now();
      if (!force && now - scaleUpdatedAt < 100) return false;
      camera.updateMatrixWorld?.(true);
      const signature = [
        camera.position.x, camera.position.y, camera.position.z,
        camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w,
        camera.fov, camera.zoom, rect.width, rect.height, scale,
      ].map((value) => Number(value).toFixed(3)).join(':');
      scaleUpdatedAt = now;
      if (!force && signature === scaleSignature) return false;
      scaleSignature = signature;

      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const nextScale = new THREE.Vector3();
      const componentColors = Object.fromEntries(CAMERA_MARKER_COMPONENTS.map((component) => [component, new THREE.Color(CAMERA_MARKER_COLORS[component])]));
      const whiteColor = new THREE.Color(0xffffff);
      const candidates = [];
      const pm = camera.projectionMatrix.elements;
      const vm = camera.matrixWorldInverse.elements;
      for (let source = 0; source < markerWorldPositions.length / 3; source += 1) {
        const offset = source * 3;
        const wx = markerWorldPositions[offset], wy = markerWorldPositions[offset + 1], wz = markerWorldPositions[offset + 2];
        const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz + vm[12];
        const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz + vm[13];
        const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
        const depth = -vz;
        markerDepths[source] = depth;
        const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz + pm[12];
        const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz + pm[13];
        const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
        if (cw <= 0) continue;
        candidates.push({
          index: source,
          x: (cx / cw * 0.5 + 0.5) * rect.width,
          y: (-cy / cw * 0.5 + 0.5) * rect.height,
          depth,
        });
      }
      const visibleSources = selectCameraMarkerRepresentatives(candidates, { width: rect.width, height: rect.height });
      drawToSource = visibleSources;
      sourceToDraw.fill(-1);
      for (let draw = 0; draw < visibleSources.length; draw += 1) {
        const source = visibleSources[draw];
        sourceToDraw[source] = draw;
        position.fromArray(markerLocalPositions, source * 3);
        quaternion.fromArray(markerQuaternions, source * 4);
        const visualScale = cameraMarkerScaleForView({
          baseScale: scale,
          depth: markerDepths[source],
          fovDegrees: camera.fov,
          zoom: camera.zoom,
          viewportHeight: rect.height,
        });
        nextScale.setScalar(visualScale);
        matrix.compose(position, quaternion, nextScale);
        const hovered = source === hoveredSource;
        for (const mesh of componentMeshes) {
          const color = componentColors[mesh.userData.cameraMarkerComponent];
          mesh.setMatrixAt(draw, matrix);
          mesh.setColorAt(draw, hovered ? color.clone().lerp(whiteColor, 0.25) : color);
        }
      }
      for (const mesh of componentMeshes) {
        mesh.count = visibleSources.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      return true;
    }

    function applySourceColor(source) {
      if (!sourceToDraw || !Number.isInteger(source) || source < 0 || source >= sourceToDraw.length) return;
      const draw = sourceToDraw[source];
      if (!Number.isInteger(draw) || draw < 0) return;
      const white = new THREE.Color(0xffffff);
      const hovered = source === hoveredSource;
      for (const mesh of componentMeshes) {
        const color = new THREE.Color(CAMERA_MARKER_COLORS[mesh.userData.cameraMarkerComponent]);
        mesh.setColorAt(draw, hovered ? color.clone().lerp(white, 0.25) : color);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    function setHovered(sourceIndex) {
      const parsed = Number(sourceIndex);
      const next = Number.isInteger(parsed) && parsed >= 0 && parsed < (sourceToDraw?.length || 0) ? parsed : -1;
      if (next === hoveredSource) return false;
      const previous = hoveredSource;
      hoveredSource = next;
      applySourceColor(previous);
      applySourceColor(next);
      return true;
    }

    function setVisible(value) {
      group.visible = Boolean(value);
      if (group.visible) updateView(true);
      else setHovered(-1);
    }

    function pick(clientX, clientY) {
      if (!group.visible || componentMeshes.length !== CAMERA_MARKER_COMPONENTS.length) return -1;
      const rect = dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const camera = getCamera();
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(componentMeshes, false)[0];
      if (Number.isInteger(hit?.instanceId)) return drawToSource[hit.instanceId];

      camera.updateMatrixWorld?.(true);
      const pm = camera.projectionMatrix.elements;
      const vm = camera.matrixWorldInverse.elements;
      const thresholdNdcX = CAMERA_MARKER_STYLE.pickRadius * 2 / rect.width;
      const thresholdNdcY = CAMERA_MARKER_STYLE.pickRadius * 2 / rect.height;
      let best = -1, bestDistance = Infinity;
      for (const source of drawToSource) {
        const offset = source * 3;
        const wx = markerWorldPositions[offset], wy = markerWorldPositions[offset + 1], wz = markerWorldPositions[offset + 2];
        const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz + vm[12];
        const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz + vm[13];
        const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
        const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz + pm[12];
        const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz + pm[13];
        const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
        if (cw <= 0) continue;
        const dx = (cx / cw - ndc.x) / thresholdNdcX;
        const dy = (cy / cw - ndc.y) / thresholdNdcY;
        const distance = dx*dx + dy*dy;
        if (distance < 1 && distance < bestDistance) { best = source; bestDistance = distance; }
      }
      return best;
    }

    function dispose() {
      disposeMeshes();
      scene.remove(group);
    }

    return Object.freeze({
      setMarkers, setScale, setVisible, setHovered, updateView, pick, dispose, group,
      get count() { return markerWorldPositions ? markerWorldPositions.length / 3 : 0; },
      get drawnCount() { return componentMeshes[0]?.count || 0; },
    });
  }

  return Object.freeze({ CAMERA_MARKER_COLORS, CAMERA_MARKER_OPACITY, CAMERA_MARKER_STYLE, DEFAULT_CAMERA_MARKER_SCALE, cameraMarkerGeometryData, cameraMarkerLocalFrame, cameraMarkerScaleForView, selectCameraMarkerRepresentatives, createCameraClickTracker, canPickCameraHover, normalizeCameraMarkers, createPointCloudCameraLayer });
}));
