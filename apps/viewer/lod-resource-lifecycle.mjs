import { preserveLodMaterials } from './lod-materials.mjs';

// The pinned renderer records its resources before load-model. Keep its original
// texture list (including PBR-only maps), but transfer material disposal ownership
// to the unlit replacements that are actually uploaded by the viewer.
export function prepareLodTileMaterials(tile, scene) {
  const materials = new Set();
  scene.traverse(object => {
    if (!object.isMesh) return;
    object.material = preserveLodMaterials(object.material);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
    }
  });
  // Non-mesh resources are not converted and still need their usual disposal.
  scene.traverse(object => {
    if (object.isMesh || !object.material) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
    }
  });
  tile.engineData.materials = [...materials];
}

export function installLodResourceLifecycle(tiles) {
  const pending = new Map();
  let disposed = false;
  const onLoad = ({ tile, scene }) => {
    prepareLodTileMaterials(tile, scene);
    // GLTFLoader has completed all afterRoot extensions before load-model. The
    // Viewer uses the resolved scene and metadata, never the parser's lazy-load
    // API. Drop only that API/cache owner, which otherwise retains the full BIN
    // body and dependency promises alongside the decoded geometry/textures.
    const metadata = tile.engineData.metadata;
    if (metadata?.parser && metadata.scene === scene && Array.isArray(metadata.scenes)) {
      delete metadata.parser;
    }
    scene.traverse(mesh => {
      if (mesh.isMesh && mesh.geometry && !mesh.geometry.boundsTree) pending.set(mesh, tile);
    });
  };
  const onDispose = ({ scene }) => {
    scene.traverse(mesh => {
      pending.delete(mesh);
      // Geometry.dispose releases GPU buffers, not the separately allocated BVH.
      mesh.geometry?.disposeBoundsTree?.();
    });
  };
  tiles.addEventListener('load-model', onLoad);
  tiles.addEventListener('dispose-model', onDispose);
  return {
    drainBVH() {
      if (disposed) return;
      while (pending.size) {
        const [mesh, tile] = pending.entries().next().value;
        pending.delete(mesh);
        if (!tiles.lruCache.has(tile) || !tile.engineData.scene
          || !mesh.geometry || mesh.geometry.boundsTree) continue;
        try { mesh.geometry.computeBoundsTree(); } catch { /* unsupported geometry */ }
        return; // Preserve the existing one-build-per-frame policy.
      }
    },
    snapshot: () => ({ pendingBvhMeshes: pending.size }),
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      tiles.removeEventListener('load-model', onLoad);
      tiles.removeEventListener('dispose-model', onDispose);
    },
  };
}
