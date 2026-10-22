import * as THREE from 'three';

export function unlitLodMaterial(source) {
  const map = source?.map || null;
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    color: source?.color?.clone?.() || new THREE.Color(0xffffff),
    map,
    lightMap: source?.lightMap || null,
    lightMapIntensity: source?.lightMapIntensity ?? 1,
    aoMap: source?.aoMap || null,
    aoMapIntensity: source?.aoMapIntensity ?? 1,
    specularMap: source?.specularMap || null,
    alphaMap: source?.alphaMap || null,
    vertexColors: Boolean(source?.vertexColors),
    transparent: Boolean(source?.transparent),
    opacity: source?.opacity ?? 1,
    alphaTest: source?.alphaTest ?? 0,
    side: THREE.FrontSide,
  });
  material.name = source?.name || '';
  material.depthTest = source?.depthTest ?? true;
  material.toneMapped = false;
  material.depthWrite = source?.depthWrite ?? true;
  return material;
}

export function preserveLodMaterials(source) {
  const originals = Array.isArray(source) ? source : [source];
  const replacements = originals.map((material) => unlitLodMaterial(material));
  originals.forEach((material) => material?.dispose?.());
  return Array.isArray(source) ? replacements : replacements[0];
}
