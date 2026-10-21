// LTDS EarthLikeControls — Google-Earth-style navigation for Three.js
//
//   Left-drag  : orbit around the surface point under the cursor at press time
//                (pivot stays INSIDE the scene; the camera never re-centers)
//   Right-drag : pan — grab the ground plane and drag it under the cursor
//   Wheel      : zoom toward / away from the point under the cursor
//   Touch      : 1 finger orbit, 2 fingers pan + pinch zoom
//
// The camera target is never snapped or lerped to the click point. Instead the
// click point becomes the temporary rotation pivot, exactly like WebODM/Potree
// EarthControls (but with left/right buttons swapped per LTDS preference).

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export function clampPolarOffset(offset, minPolar, maxPolar, fallbackHorizontal = new THREE.Vector3(0, 0, 1)) {
  const value = offset.clone();
  const radius = value.length();
  if (!Number.isFinite(radius) || radius < 1e-9) return value;
  const polar = Math.acos(THREE.MathUtils.clamp(value.y / radius, -1, 1));
  const target = THREE.MathUtils.clamp(polar, minPolar, maxPolar);
  if (Math.abs(target - polar) < 1e-12) return value;
  const horizontal = new THREE.Vector3(value.x, 0, value.z);
  if (horizontal.lengthSq() < 1e-12) {
    horizontal.copy(fallbackHorizontal);
    horizontal.y = 0;
  }
  if (horizontal.lengthSq() < 1e-12) horizontal.set(0, 0, 1);
  horizontal.normalize().multiplyScalar(radius * Math.sin(target));
  horizontal.y = radius * Math.cos(target);
  return horizontal;
}

export function safeTopViewPosition(target, radius, minPolar, epsilon = 0.001) {
  const distance = Number(radius);
  const minimum = Number(minPolar);
  if (!target?.clone || !Number.isFinite(distance) || distance <= 0 || !Number.isFinite(minimum)) {
    throw new TypeError('invalid top-view geometry');
  }
  const polar = THREE.MathUtils.clamp(minimum + Math.max(0.0001, Number(epsilon) || 0.001), 0.0001, Math.PI - 0.0001);
  return target.clone().add(new THREE.Vector3(0, distance * Math.cos(polar), distance * Math.sin(polar)));
}

export function stableLookQuaternion(forward, expectedRight, target = new THREE.Quaternion()) {
  const fwd = forward.clone().normalize();
  let right = new THREE.Vector3().crossVectors(fwd, UP);
  const expected = expectedRight.clone().addScaledVector(fwd, -expectedRight.dot(fwd));
  if (right.lengthSq() < 0.12 ** 2) right.copy(expected);
  if (right.lengthSq() < 1e-10) {
    right.crossVectors(fwd, Math.abs(fwd.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0));
  }
  right.normalize();
  if (expected.lengthSq() > 1e-10 && right.dot(expected) < 0) right.negate();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const basis = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
  return target.setFromRotationMatrix(basis).normalize();
}

export class EarthLikeControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   * @param {Object} opts
   *   surfacePick(ndc: THREE.Vector2) -> THREE.Vector3|null  raycast the scene
   *   minPolar / maxPolar : polar angle clamps (rad from +Y)
   *   fallbackPlaneY      : ground plane height used when no surface hit
   */
  constructor(camera, domElement, opts = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.surfacePick = opts.surfacePick || (() => null);
    this.minPolar = opts.minPolar ?? 0.03;
    this.maxPolar = opts.maxPolar ?? 1.53;   // ~87.7deg — can't dive under
    this.fallbackPlaneY = opts.fallbackPlaneY ?? 0;
    this.minDistance = opts.minDistance ?? 0.3;
    this.maxDistance = opts.maxDistance ?? 8000;
    this.rotateSpeed = opts.rotateSpeed ?? 1.0;
    this.enabled = true;

    this._mode = 'none';          // none | orbit | pan
    this._pivot = new THREE.Vector3();
    this._panPlane = new THREE.Plane(UP.clone(), 0);
    this._panStart = new THREE.Vector3();
    this._lastPx = { x: 0, y: 0 };
    this._downPx = { x: 0, y: 0 };
    this._moved = 0;
    this._raycaster = new THREE.Raycaster();
    this._inertia = { yaw: 0, pitch: 0, active: false };
    this._lastMoveTime = 0;
    this._touches = new Map();
    this._pinch = null;
    this._focusNdc = new THREE.Vector2(0, 0);
    this._focusPoint = null;
    this._lastActivityTime = 0;

    // Pivot indicator (orange ring dot shown while orbiting)
    this.pivotIndicator = this._buildIndicator();

    this._onPointerDown = this._pointerDown.bind(this);
    this._onPointerMove = this._pointerMove.bind(this);
    this._onPointerUp = this._pointerUp.bind(this);
    this._onWheel = this._wheel.bind(this);
    this._onContext = (e) => e.preventDefault();

    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onContext);
  }

  _buildIndicator() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = '#EE5007';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(32, 32, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(32, 32, 6, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(cv);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthTest: false
    }));
    sprite.renderOrder = 1000;
    sprite.visible = false;
    return sprite;
  }

  _ndc(e) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  _ray(ndc) {
    this._raycaster.setFromCamera(ndc, this.camera);
    return this._raycaster.ray;
  }

  _planeHit(ndc, planeY) {
    const ray = this._ray(ndc);
    const plane = new THREE.Plane(UP, -(planeY ?? this.fallbackPlaneY));
    const out = new THREE.Vector3();
    return ray.intersectPlane(plane, out) ? out : null;
  }

  /** surface point under cursor, or ground-plane fallback, or point ahead */
  _anchor(ndc) {
    const hit = this.surfacePick(ndc);
    if (hit) return hit.clone();
    const ph = this._planeHit(ndc);
    if (ph && ph.distanceTo(this.camera.position) < this.maxDistance * 2) return ph;
    const ray = this._ray(ndc);
    return ray.origin.clone().addScaledVector(ray.direction, 50);
  }

  _markInteraction(ndc = this._focusNdc, point = null) {
    if (ndc?.isVector2) this._focusNdc.copy(ndc);
    if (point?.isVector3) this._focusPoint = point.clone();
    this._lastActivityTime = performance.now();
  }

  /** Read-only camera interaction state used to prioritize (never select) LOD requests. */
  getInteractionState() {
    return Object.freeze({
      focusNdc: Object.freeze([this._focusNdc.x, this._focusNdc.y]),
      focusPoint: this._focusPoint ? Object.freeze(this._focusPoint.toArray()) : null,
      activeMotion: this._mode !== 'none' || this._inertia.active,
      lastActivityTime: this._lastActivityTime,
    });
  }

  _pointerDown(e) {
    if (!this.enabled) return;
    this.dom.setPointerCapture?.(e.pointerId);
    this._inertia.active = false;

    if (e.pointerType === 'touch') {
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._touches.size === 2) {
        const pts = [...this._touches.values()];
        this._pinch = {
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        };
        const midNdc = this._ndcFromClient(this._pinch.mid.x, this._pinch.mid.y);
        const a = this._anchor(midNdc);
        this._panPlane.set(UP, -a.y);
        this._panStart.copy(this._planeHit(midNdc, a.y) || a);
        this._mode = 'pan';
        return;
      }
    }

    this._downPx = { x: e.clientX, y: e.clientY };
    this._lastPx = { x: e.clientX, y: e.clientY };
    this._moved = 0;
    const ndc = this._ndc(e);
    this._markInteraction(ndc, this._anchor(ndc));

    if (e.button === 0 || e.pointerType === 'touch') {
      const surface = this.surfacePick(ndc);
      if (!surface) {
        this._mode = 'none';
        return;
      }
      this._pivot.copy(surface);
      this._mode = 'orbit';
      this.pivotIndicator.position.copy(this._pivot);
      this.pivotIndicator.material.opacity = 0;
      this._inertia.yaw = 0; this._inertia.pitch = 0;
    } else if (e.button === 2) {
      const a = this._anchor(ndc);
      this._panPlane.set(UP, -a.y);
      const start = this._planeHit(ndc, a.y);
      if (!start) { this._mode = 'none'; return; }
      this._panStart.copy(start);
      this._mode = 'pan';
    } else if (e.button === 1) {
      // middle = free screen-space pan: scene follows the mouse in any direction
      const a = this._anchor(ndc);
      this._screenRef = Math.max(1, this.camera.position.distanceTo(a));
      this._mode = 'screenpan';
      e.preventDefault();
    }
  }

  _ndcFromClient(cx, cy) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }

  _pointerMove(e) {
    if (!this.enabled) return;

    if (e.pointerType === 'touch' && this._touches.has(e.pointerId)) {
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._touches.size === 2 && this._pinch) {
        const pts = [...this._touches.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        // pinch zoom toward midpoint
        if (this._pinch.dist > 0 && dist > 0) {
          const midNdc = this._ndcFromClient(mid.x, mid.y);
          const hit = this._anchor(midNdc);
          const s = this._pinch.dist / dist;
          this._zoomTowards(hit, s);
        }
        // two finger pan
        const midNdc = this._ndcFromClient(mid.x, mid.y);
        const cur = this._planeHit(midNdc, -this._panPlane.constant);
        if (cur) {
          const delta = new THREE.Vector3().subVectors(this._panStart, cur);
          if (delta.length() < 1000) this.camera.position.add(delta);
        }
        this._pinch.dist = dist; this._pinch.mid = mid;
        return;
      }
    }

    if (this._mode === 'none') return;
    const dx = e.clientX - this._lastPx.x;
    const dy = e.clientY - this._lastPx.y;
    this._lastPx = { x: e.clientX, y: e.clientY };
    this._moved += Math.abs(dx) + Math.abs(dy);
    if (dx === 0 && dy === 0) return;
    this._markInteraction(this._ndc(e));

    if (this._mode === 'orbit') {
      const h = this.dom.clientHeight || 800;
      const yawDelta = -(dx / h) * Math.PI * 2 * this.rotateSpeed * 0.55;
      const pitchDelta = -(dy / h) * Math.PI * 2 * this.rotateSpeed * 0.55;
      this._applyOrbit(this._pivot, yawDelta, pitchDelta);

      const now = performance.now();
      const dt = Math.max(8, now - this._lastMoveTime) / 1000;
      this._lastMoveTime = now;
      this._inertia.yaw = yawDelta / dt;
      this._inertia.pitch = pitchDelta / dt;

      this.pivotIndicator.visible = true;
      this.pivotIndicator.material.opacity = Math.min(1, this.pivotIndicator.material.opacity + 0.2);
      this._scaleIndicator();
    } else if (this._mode === 'pan') {
      const ndc = this._ndc(e);
      const ray = this._ray(ndc);
      const denom = ray.direction.dot(this._panPlane.normal);
      if (Math.abs(denom) < 0.02) return;   // ray nearly parallel to plane
      const cur = new THREE.Vector3();
      if (!ray.intersectPlane(this._panPlane, cur)) return;
      const delta = new THREE.Vector3().subVectors(this._panStart, cur);
      const maxStep = Math.max(50, this.camera.position.distanceTo(cur) * 2);
      if (delta.length() > maxStep) delta.setLength(maxStep);
      this.camera.position.add(delta);
    } else if (this._mode === 'screenpan') {
      // translate along the camera's right/up axes so the content tracks the
      // cursor 1:1 at the grabbed depth (not locked to any world axis)
      const h = this.dom.clientHeight || 800;
      const wpp = 2 * this._screenRef * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / h;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      this.camera.position.addScaledVector(right, -dx * wpp);
      this.camera.position.addScaledVector(up, dy * wpp);
    }
  }

  _pointerUp(e) {
    if (e.pointerType === 'touch') {
      this._touches.delete(e.pointerId);
      if (this._touches.size < 2) this._pinch = null;
      if (this._touches.size === 0) this._endDrag();
      return;
    }
    this._endDrag();
  }

  _endDrag() {
    if (this._mode === 'orbit') {
      const speed = Math.abs(this._inertia.yaw) + Math.abs(this._inertia.pitch);
      const fresh = performance.now() - this._lastMoveTime < 60;
      this._inertia.active = fresh && speed > 0.15;
    }
    this._mode = 'none';
  }

  /** was the last press-release a click (no real drag)? */
  wasClick() { return this._moved < 5; }

  _applyOrbit(pivot, yawDelta, pitchDelta) {
    const cam = this.camera;
    // The picked pivot may be off-centre; never snap its offset to the camera
    // inclination limits. Clamp the view ray below, preserving the picked orbit.
    const offset = new THREE.Vector3().subVectors(cam.position, pivot);
    const r = offset.length();
    if (r < 1e-6) return;

    // side axis = camera right, projected horizontal
    let side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    side.y = 0;
    if (side.lengthSq() < 1e-8) {
      side = new THREE.Vector3().crossVectors(offset, UP);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    }
    side.normalize();

    // Clamp the signed camera inclination BEFORE rotating. acos of the final
    // pivot offset folds across the pole, so a large drag could skip the entire
    // forbidden interval. An off-centre pivot also differs from the view ray.
    const beforeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const horizontalForward = new THREE.Vector3().crossVectors(UP, side);
    const inclination = Math.atan2(-beforeForward.dot(UP), beforeForward.dot(horizontalForward));
    const nextInclination = THREE.MathUtils.clamp(inclination - pitchDelta,
      Math.PI / 2 - this.maxPolar, Math.PI / 2 - this.minPolar);
    const pd = inclination - nextInclination;

    const qPitch = new THREE.Quaternion().setFromAxisAngle(side, pd);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, yawDelta);
    const q = new THREE.Quaternion().multiplyQuaternions(qYaw, qPitch);

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).applyQuaternion(q);
    const expectedRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).applyQuaternion(q);

    offset.applyQuaternion(q);
    cam.position.copy(pivot).add(offset);
    // Keep the previous right-axis hemisphere while the view direction is
    // nearly vertical. A raw world-up lookAt becomes singular there and can
    // jump by 180 degrees even though the orbit offset never crossed the pole.
    stableLookQuaternion(fwd, expectedRight, cam.quaternion);
  }

  _zoomTowards(hit, s) {
    const cam = this.camera;
    const offset = new THREE.Vector3().subVectors(cam.position, hit);
    if (!Number.isFinite(s) || s <= 0 || offset.lengthSq() <= 1e-12) return;
    let d = offset.length() * s;
    d = THREE.MathUtils.clamp(d, this.minDistance, this.maxDistance);
    offset.setLength(d);
    cam.position.copy(hit).add(offset);
  }

  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const ndc = this._ndc(e);
    const hit = this._anchor(ndc);
    this._markInteraction(ndc, hit);
    const s = Math.pow(0.90, -e.deltaY / 100);
    this._zoomTowards(hit, s);
  }

  _scaleIndicator() {
    const d = this.camera.position.distanceTo(this.pivotIndicator.position);
    this.pivotIndicator.scale.setScalar(Math.max(0.3, d / 40));
  }

  /** call every frame */
  update(dt) {
    if (this._inertia.active) {
      const decay = Math.exp(-dt * 5.5);
      this._inertia.yaw *= decay;
      this._inertia.pitch *= decay;
      if (Math.abs(this._inertia.yaw) + Math.abs(this._inertia.pitch) < 0.02) {
        this._inertia.active = false;
      } else {
        this._applyOrbit(this._pivot, this._inertia.yaw * dt, this._inertia.pitch * dt);
        this._markInteraction(this._focusNdc, this._pivot);
      }
    }
    // fade the pivot indicator when not orbiting
    if (this._mode !== 'orbit' && this.pivotIndicator.visible) {
      this.pivotIndicator.material.opacity -= dt * 2.5;
      this._scaleIndicator();
      if (this.pivotIndicator.material.opacity <= 0) {
        this.pivotIndicator.visible = false;
        this.pivotIndicator.material.opacity = 0;
      }
    }
  }

  /** point the camera at a target from a position (used by reset/home/top) */
  setView(position, lookAt) {
    const offset = clampPolarOffset(
      new THREE.Vector3().subVectors(position, lookAt),
      this.minPolar,
      this.maxPolar,
      new THREE.Vector3(0, 0, 1),
    );
    this.camera.position.copy(lookAt).add(offset);
    this.camera.lookAt(lookAt);
    this._inertia.active = false;
    this._markInteraction(new THREE.Vector2(0, 0), lookAt);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContext);
  }
}
