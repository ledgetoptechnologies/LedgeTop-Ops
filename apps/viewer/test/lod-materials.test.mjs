import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { preserveLodMaterials } from '../lod-materials.mjs';

test('multi-material LOD conversion retains independent texture and render state', () => {
  const mapA = new THREE.Texture();
  const mapB = new THREE.Texture();
  const alphaA = new THREE.Texture();
  const alphaB = new THREE.Texture();
  const originalA = new THREE.MeshStandardMaterial({
    color: 0x884422,
    map: mapA,
    alphaMap: alphaA,
    transparent: true,
    opacity: 0.65,
    alphaTest: 0.25,
    vertexColors: true,
  });
  const originalB = new THREE.MeshStandardMaterial({
    color: 0x226688,
    map: mapB,
    alphaMap: alphaB,
    transparent: false,
    opacity: 0.9,
    alphaTest: 0.1,
    vertexColors: false,
  });
  let disposedA = 0, disposedB = 0;
  originalA.dispose = () => { disposedA += 1; };
  originalB.dispose = () => { disposedB += 1; };

  const converted = preserveLodMaterials([originalA, originalB]);

  assert.equal(converted.length, 2);
  assert.notEqual(converted[0], converted[1]);
  assert.equal(converted[0].map, mapA);
  assert.equal(converted[1].map, mapB);
  assert.equal(converted[0].alphaMap, alphaA);
  assert.equal(converted[1].alphaMap, alphaB);
  assert.equal(converted[0].vertexColors, true);
  assert.equal(converted[1].vertexColors, false);
  assert.equal(converted[0].transparent, true);
  assert.equal(converted[0].opacity, 0.65);
  assert.equal(converted[0].alphaTest, 0.25);
  assert.equal(converted[0].color.getHex(), 0x884422);
  assert.equal(converted[1].color.getHex(), 0x226688);
  assert.equal(converted[0].depthWrite, true);
  assert.equal(converted[1].depthWrite, true);
  assert.equal(mapA.colorSpace, THREE.SRGBColorSpace);
  assert.equal(mapB.colorSpace, THREE.SRGBColorSpace);
  assert.equal(disposedA, 1);
  assert.equal(disposedB, 1);
});

test('single material conversion preserves the non-array API shape', () => {
  const original = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const converted = preserveLodMaterials(original);
  assert.equal(Array.isArray(converted), false);
  assert.equal(converted.map, original.map);
});

test('standard REPLACE root material writes depth without an underlay offset', () => {
  const original = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const converted = preserveLodMaterials(original);
  assert.equal(converted.depthWrite, true);
  assert.equal(converted.polygonOffset, false);
});
