(function pointCloudParcelModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudParcels = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPointCloudParcelModule() {
  const PARCEL_LINE_COLOR = 0xFFD60A;
  const MAX_VERTICES = 120000;

  // Lines arrive in UTM metres [[e, n, alt], ...]. Store them relative to a
  // local origin so float32 GPU positions keep centimetre precision.
  function parcelSegments(lines) {
    if (!Array.isArray(lines)) return null;
    let origin = null, count = 0;
    const segments = [];
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2) continue;
      for (let i = 1; i < line.length; i += 1) {
        const a = line[i - 1], b = line[i];
        if (![a?.[0], a?.[1], a?.[2], b?.[0], b?.[1], b?.[2]].every(Number.isFinite)) continue;
        if (!origin) origin = [a[0], a[1], a[2]];
        segments.push(a[0] - origin[0], a[1] - origin[1], a[2] - origin[2], b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]);
        count += 2;
        if (count > MAX_VERTICES) return null;
      }
    }
    return { origin: origin || [0, 0, 0], positions: segments, vertexCount: count };
  }

  // Drawn in Potree's overlay pass (as camera markers are) so the EDL
  // composite cannot erase it; the lines therefore always show on top.
  function createPointCloudParcelLayer({ THREE, scene }) {
    if (!THREE?.LineSegments || !scene?.add) throw new TypeError('invalid point-cloud parcel layer dependencies');
    const group = new THREE.Group();
    group.name = 'ltds-property-lines';
    group.visible = false;
    scene.add(group);
    let line = null;

    function clear() {
      if (!line) return;
      group.remove(line);
      line.geometry.dispose();
      line.material.dispose();
      line = null;
    }

    return {
      group,
      get vertexCount() { return line ? line.geometry.getAttribute('position').count : 0; },
      setLines(lines) {
        clear();
        const data = parcelSegments(lines);
        if (!data) return -1;
        if (!data.vertexCount) return 0;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
        const material = new THREE.LineBasicMaterial({ color: PARCEL_LINE_COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
        line = new THREE.LineSegments(geometry, material);
        line.position.set(data.origin[0], data.origin[1], data.origin[2]);
        line.frustumCulled = false;
        line.renderOrder = 10;
        group.add(line);
        return data.vertexCount;
      },
      setVisible(visible) { group.visible = Boolean(visible); },
      clear,
    };
  }

  return Object.freeze({ PARCEL_LINE_COLOR, parcelSegments, createPointCloudParcelLayer });
}));
