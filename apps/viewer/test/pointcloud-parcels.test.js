'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parcelSegments, createPointCloudParcelLayer } = require('../public/pointcloud-parcels.js');

test('point-cloud parcel lines are stored around a local origin for float precision', () => {
  const data = parcelSegments([[[305000.25, 4771000.5, 260], [305010.25, 4771000.5, 261], [305010.25, 4771010.5, 262]]]);
  assert.deepEqual(data.origin, [305000.25, 4771000.5, 260]);
  assert.equal(data.vertexCount, 4);
  assert.deepEqual(data.positions, [0, 0, 0, 10, 0, 1, 10, 0, 1, 10, 10, 2]);
  assert.equal(parcelSegments('nope'), null);
  assert.equal(parcelSegments([[[1, 2, NaN], [1, 2, 3]]]).vertexCount, 0);
});

test('point-cloud parcel layer draws, hides and clears', () => {
  class Object3D { constructor() { this.children = []; this.visible = true; this.position = { set: (...v) => { this.at = v; } }; } add(c) { this.children.push(c); } remove(c) { this.children = this.children.filter(x => x !== c); } }
  class BufferGeometry { setAttribute(name, attr) { this.attr = attr; } getAttribute() { return this.attr; } dispose() { this.disposed = true; } }
  const THREE = {
    Group: Object3D,
    BufferGeometry,
    Float32BufferAttribute: class { constructor(values) { this.count = values.length / 3; } },
    LineBasicMaterial: class { constructor(options) { Object.assign(this, options); } dispose() {} },
    LineSegments: class extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } },
  };
  const scene = new Object3D();
  const layer = createPointCloudParcelLayer({ THREE, scene });
  assert.equal(layer.setLines([[[1, 2, 3], [4, 5, 6]]]), 2);
  assert.equal(layer.vertexCount, 2);
  assert.equal(layer.group.children[0].material.depthTest, false);
  layer.setVisible(true);
  assert.equal(layer.group.visible, true);
  assert.equal(layer.setLines([]), 0);
  assert.equal(layer.vertexCount, 0);
});

test('Potree page loads the parcel layer and exposes it to the parent viewer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'pointcloud.html'), 'utf8');
  assert.match(html, /<script src="\/pointcloud-parcels\.js"><\/script>/);
  assert.match(html, /setParcelLines\(lines\)/);
  assert.match(html, /setParcelVisibility\(visible\)/);
  assert.match(html, /getSceneBounds\(\)/);
});
