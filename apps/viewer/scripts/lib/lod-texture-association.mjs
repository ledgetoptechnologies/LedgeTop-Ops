import crypto from 'node:crypto';

// Explicit resource/profile admission for the current pinned Obj2Tiles writer,
// not a general glTF decoder. No fixture reference, decoded pixels or readiness
// claim is supplied by this module. Geometry is separately checked by V4.
export const ASSOCIATION_LIMITS = Object.freeze({ fileBytes: 512 * 1024 ** 2, jsonBytes: 16 * 1024 ** 2,
  triangles: 4_000_000, vertices: 12_000_000, collections: 16384, imageBytes: 128 * 1024 ** 2,
  imageEdge: 16384, tiles: 100000, depth: 32 });
const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const MAGIC = Buffer.from('ab4b5458203230bb0d0a1a0a', 'hex');
const fail = code => { throw Object.assign(new Error(code), { code: `lod_texture_${code}` }); };
const check = (value, code) => { if (!value) fail(code); };
const integer = (value, minimum, maximum) => { check(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'bounds'); return value; };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const basename = name => { check(typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 255
  && !/[\\/:\x00-\x1f]/.test(name) && name !== '.' && name !== '..', 'image_identity'); return name; };
function parseJson(bytes) {
  check(bytes.length <= ASSOCIATION_LIMITS.jsonBytes, 'json_budget');
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('json_invalid'); }
}
function identityTransform(value) { return value == null || Array.isArray(value) && value.length === 16 && value.every((v, i) => v === IDENTITY[i]); }

export function renderContents(tileset) {
  check(tileset && ['1.0','1.1'].includes(tileset.asset?.version) && tileset.root?.content?.uri === 'root.b3dm', 'hierarchy_profile');
  const contents = [], seen = new Set(); let nodes = 0;
  const visit = (tile, depth) => {
    check(tile && typeof tile === 'object' && ++nodes <= ASSOCIATION_LIMITS.tiles && depth <= ASSOCIATION_LIMITS.depth, 'hierarchy_budget');
    check(identityTransform(tile.transform), 'unsupported_tile_transform');
    const children = tile.children ?? []; check(Array.isArray(children), 'hierarchy_children');
    if (tile.content != null) {
      const uri = tile.content.uri;
      check(typeof uri === 'string' && /^(?:root\.b3dm|LOD-[0-2]\/[A-Za-z0-9_.-]+\.b3dm)$/.test(uri)
        && !seen.has(uri) && tile.content.url === undefined && tile.contents === undefined, 'content_identity');
      seen.add(uri); contents.push({ uri, fullDetail: uri.startsWith('LOD-0/') });
      check(children.length ? !uri.startsWith('LOD-0/') : uri.startsWith('LOD-0/'), 'hierarchy_lod_profile');
    } else check(children.length > 0 && tile.contents === undefined, 'leaf_content_missing');
    for (const child of children) visit(child, depth + 1);
  };
  visit(tileset.root, 0);
  check(contents.some(content => content.fullDetail), 'lod0_missing');
  return contents;
}

export function inspectKtx(bytes) {
  check(bytes.length >= 104 && bytes.length <= ASSOCIATION_LIMITS.imageBytes && bytes.subarray(0, 12).equals(MAGIC), 'ktx_header');
  const width = integer(bytes.readUInt32LE(20), 1, ASSOCIATION_LIMITS.imageEdge);
  const height = integer(bytes.readUInt32LE(24), 1, ASSOCIATION_LIMITS.imageEdge);
  const levels = integer(bytes.readUInt32LE(40), 1, 15);
  check(bytes.readUInt32LE(28) === 0 && bytes.readUInt32LE(32) === 0 && bytes.readUInt32LE(36) === 1
    && levels === 1 + Math.floor(Math.log2(Math.max(width, height))) && 80 + levels * 24 <= bytes.length, 'ktx_dimensions');
  const ranges = [];
  for (let level = 0; level < levels; level++) {
    const offset = integer(Number(bytes.readBigUInt64LE(80 + level * 24)), 80 + levels * 24, bytes.length);
    const length = integer(Number(bytes.readBigUInt64LE(88 + level * 24)), 1, bytes.length);
    check(offset + length <= bytes.length, 'ktx_level_bounds'); ranges.push([offset, offset + length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  check(ranges.every((range, index) => !index || range[0] >= ranges[index - 1][1]), 'ktx_level_overlap');
  return { width, height, levels };
}

// Accessors read individual values from the original bounded Buffer. No array
// proportional to an attacker-supplied accessor count is allocated.
export function inspectEmbeddedTile(bytes, { checkpoint = () => {} } = {}) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 56 && bytes.length <= ASSOCIATION_LIMITS.fileBytes, 'file_budget');
  check(bytes.toString('ascii', 0, 4) === 'b3dm' && bytes.readUInt32LE(4) === 1 && bytes.readUInt32LE(8) === bytes.length, 'b3dm_header');
  const tableSizes = [12,16,20,24].map(at => integer(bytes.readUInt32LE(at), 0, ASSOCIATION_LIMITS.jsonBytes));
  const start = 28 + tableSizes.reduce((sum, value) => sum + value, 0);
  check(start % 8 === 0 && bytes.length % 8 === 0 && start + 28 <= bytes.length, 'b3dm_alignment');
  const feature = tableSizes[0] ? parseJson(bytes.subarray(28, 28 + tableSizes[0])) : {};
  check(!feature.RTC_CENTER || Array.isArray(feature.RTC_CENTER) && feature.RTC_CENTER.length === 3 && feature.RTC_CENTER.every(value => value === 0), 'unsupported_rtc');
  check(bytes.readUInt32LE(start) === 0x46546c67 && bytes.readUInt32LE(start + 4) === 2, 'glb_header');
  const glbLength = integer(bytes.readUInt32LE(start + 8), 28, bytes.length - start);
  const padding = bytes.subarray(start + glbLength);
  check(glbLength % 4 === 0 && padding.length === (8 - glbLength % 8) % 8 && padding.every(value => value === 0x20), 'b3dm_padding');
  let offset = start + 12, model = null, bin = null;
  while (offset < start + glbLength) {
    check(offset + 8 <= start + glbLength, 'glb_chunk');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); offset += 8;
    check(length % 4 === 0 && offset + length <= start + glbLength, 'glb_chunk');
    if (type === 0x4e4f534a) { check(!model && !bin, 'glb_order'); model = parseJson(bytes.subarray(offset, offset + length)); }
    else if (type === 0x004e4942) { check(model && !bin, 'glb_order'); bin = bytes.subarray(offset, offset + length); }
    else fail('glb_chunk');
    offset += length;
  }
  check(model?.asset?.version === '2.0' && bin && model.buffers?.length === 1 && !model.buffers[0].uri
    && Number.isSafeInteger(model.buffers[0].byteLength) && model.buffers[0].byteLength > 0
    && model.buffers[0].byteLength <= bin.length && bin.length - model.buffers[0].byteLength <= 3, 'glb_payload');
  for (const key of ['accessors','bufferViews','meshes','nodes','images','materials','textures'])
    check(Array.isArray(model[key]) && model[key].length <= ASSOCIATION_LIMITS.collections, 'collection_budget');
  check(!Object.keys(model.extensions || {}).length && !model.animations?.length && !model.skins?.length
    && (model.extensionsRequired || []).every(name => ['KHR_texture_basisu','KHR_materials_unlit'].includes(name)), 'unsupported_extension');
  const view = index => {
    integer(index, 0, model.bufferViews.length - 1); const value = model.bufferViews[index];
    check(value && (value.buffer ?? 0) === 0 && !value.extensions, 'buffer_view');
    const begin = integer(value.byteOffset ?? 0, 0, bin.length), length = integer(value.byteLength, 1, bin.length);
    check(begin + length <= model.buffers[0].byteLength, 'buffer_view_bounds'); return { ...value, begin, length };
  };
  const accessor = (index, kind) => {
    integer(index, 0, model.accessors.length - 1); const value = model.accessors[index];
    const width = kind === 'position' ? 3 : kind === 'uv' ? 2 : 1;
    check(value && !value.sparse && !value.normalized && !value.extensions && value.type === ['','SCALAR','VEC2','VEC3'][width], 'accessor_profile');
    check(kind === 'index' ? [5121,5123,5125].includes(value.componentType) : value.componentType === 5126, 'accessor_component');
    const size = {5121:1,5123:2,5125:4,5126:4}[value.componentType], bufferView = view(value.bufferView);
    const count = integer(value.count, 1, kind === 'index' ? ASSOCIATION_LIMITS.triangles * 3 : ASSOCIATION_LIMITS.vertices);
    const stride = integer(bufferView.byteStride ?? width * size, width * size, 256), relative = integer(value.byteOffset ?? 0, 0, bufferView.length);
    check(stride % size === 0 && (bufferView.begin + relative) % size === 0
      && relative + (count - 1) * stride + width * size <= bufferView.length, 'accessor_bounds');
    const reader = {5121:'readUInt8',5123:'readUInt16LE',5125:'readUInt32LE',5126:'readFloatLE'}[value.componentType];
    return { count, width, size, identity: `${bufferView.begin + relative}:${count}:${width}:${stride}:${value.componentType}`, get(row, column = 0) {
      integer(row, 0, count - 1); integer(column, 0, width - 1);
      const result = bin[reader](bufferView.begin + relative + row * stride + column * size);
      check(Number.isFinite(result), 'accessor_nonfinite'); return result;
    } };
  };
  const validatedAttributes = new Set(), validatedIndices = new Map(); let validationBytes = 0;
  const reserveValidation = value => {
    validationBytes += value.count * value.width * value.size;
    check(validationBytes <= ASSOCIATION_LIMITS.fileBytes, 'accessor_work_budget');
  };
  const validateAttribute = value => {
    if (validatedAttributes.has(value.identity)) return;
    reserveValidation(value);
    for (let row = 0; row < value.count; row++) {
      if (row % 1024 === 0) checkpoint();
      for (let column = 0; column < value.width; column++) value.get(row, column);
    }
    validatedAttributes.add(value.identity);
  };
  const maximumIndex = value => {
    if (validatedIndices.has(value.identity)) return validatedIndices.get(value.identity);
    reserveValidation(value); let maximum = 0;
    for (let at = 0; at < value.count; at++) {
      if (at % 3072 === 0) checkpoint(); maximum = Math.max(maximum, value.get(at));
    }
    validatedIndices.set(value.identity, maximum); return maximum;
  };
  const imageHashes = new Map(); let imageHashBytes = 0;
  const allImages = model.images.map(image => {
    checkpoint();
    check(image?.mimeType === 'image/ktx2' && !image.uri && !Object.keys(image.extensions || {}).length, 'embedded_image_required');
    const name = basename(image.name), v = view(image.bufferView), data = bin.subarray(v.begin, v.begin + v.length);
    const key = `${v.begin}:${v.length}`;
    if (!imageHashes.has(key)) {
      imageHashBytes += v.length; check(imageHashBytes <= ASSOCIATION_LIMITS.fileBytes, 'image_hash_budget');
      imageHashes.set(key, sha(data));
    }
    return { name, bytes: data, sha256: imageHashes.get(key), ...inspectKtx(data) };
  });
  const images = new Map(), primitives = [], seenNodes = new Set(), seenMeshes = new Set();
  const usedMaterials = new Set(), usedTextures = new Set(), usedImages = new Set(); let triangles = 0;
  const visit = (index, depth = 0) => {
    checkpoint(); check(depth <= ASSOCIATION_LIMITS.depth, 'node_depth');
    integer(index, 0, model.nodes.length - 1); check(!seenNodes.has(index), 'node_cycle_or_instance'); seenNodes.add(index);
    const node = model.nodes[index];
    check(node && typeof node === 'object' && !Array.isArray(node), 'node_profile');
    check(identityTransform(node.matrix) && (!node.translation || node.translation.length === 3 && node.translation.every(value => value === 0))
      && (!node.rotation || node.rotation.length === 4 && node.rotation.every((value, i) => value === (i === 3 ? 1 : 0)))
      && (!node.scale || node.scale.length === 3 && node.scale.every(value => value === 1))
      && node.skin === undefined && !node.weights && node.camera === undefined && !Object.keys(node.extensions || {}).length, 'unsupported_node_transform');
    if (node.mesh !== undefined) {
      integer(node.mesh, 0, model.meshes.length - 1); check(!seenMeshes.has(node.mesh), 'mesh_instance'); seenMeshes.add(node.mesh);
      const mesh = model.meshes[node.mesh]; check(Array.isArray(mesh.primitives) && !mesh.weights, 'mesh_profile');
      for (const primitive of mesh.primitives) {
        checkpoint(); check(primitives.length < ASSOCIATION_LIMITS.collections, 'primitive_budget');
        check(primitive && (primitive.mode ?? 4) === 4 && !primitive.extensions && !primitive.targets
          && Object.keys(primitive.attributes || {}).every(key => ['POSITION','NORMAL','TEXCOORD_0','TANGENT'].includes(key)), 'primitive_profile');
        const positions = accessor(primitive.attributes?.POSITION, 'position'), uv = accessor(primitive.attributes?.TEXCOORD_0, 'uv'), indices = accessor(primitive.indices, 'index');
        check(positions.count === uv.count && indices.count % 3 === 0, 'triangle_count');
        triangles += indices.count / 3; check(triangles <= ASSOCIATION_LIMITS.triangles, 'triangle_budget');
        validateAttribute(positions); validateAttribute(uv);
        check(maximumIndex(indices) < positions.count, 'index_bounds');
        integer(primitive.material, 0, model.materials.length - 1);
        usedMaterials.add(primitive.material);
        const material = model.materials[primitive.material], info = material?.pbrMetallicRoughness?.baseColorTexture;
        check(info && !info.extensions && (info.texCoord ?? 0) === 0 && (!material.alphaMode || material.alphaMode === 'OPAQUE'), 'material_profile');
        check(!material.normalTexture && !material.occlusionTexture && !material.emissiveTexture
          && !material.pbrMetallicRoughness.metallicRoughnessTexture
          && Object.keys(material.extensions || {}).every(name => name === 'KHR_materials_unlit'), 'material_profile');
        check(!material.emissiveFactor || material.emissiveFactor.length === 3 && material.emissiveFactor.every(value => value === 0), 'emissive_factor');
        const factor = material.pbrMetallicRoughness.baseColorFactor;
        check(!factor || factor.length === 4 && factor.every(value => value === 1), 'base_color_factor');
        integer(info.index, 0, model.textures.length - 1); const texture = model.textures[info.index];
        usedTextures.add(info.index);
        const source = texture?.extensions?.KHR_texture_basisu?.source;
        integer(source, 0, allImages.length - 1);
        usedImages.add(source);
        check(texture.source === undefined && Object.keys(texture.extensions).every(name => name === 'KHR_texture_basisu'), 'basis_source');
        const image = allImages[source]; check(!images.has(image.name) || images.get(image.name).sha256 === image.sha256, 'image_alias'); images.set(image.name, image);
        primitives.push({ positions, uv, indices, image });
      }
    }
    const children = node.children ?? []; check(Array.isArray(children), 'node_children');
    for (const child of children) visit(child, depth + 1);
  };
  const roots = model.scenes?.[model.scene ?? 0]?.nodes;
  check(Array.isArray(roots) && roots.length > 0, 'scene_roots');
  for (const root of roots) visit(root);
  check(seenNodes.size === model.nodes.length && seenMeshes.size === model.meshes.length && triangles > 0, 'unreferenced_or_empty_geometry');
  check(usedTextures.size === model.textures.length && usedImages.size === allImages.length, 'unreferenced_material_image');
  // SharpGLTF emits an inert, unused default material. It is not an image and
  // cannot hide an unverified texture; account for only resource-free PBR data.
  const unusedUntexturedMaterials = [];
  for (let index = 0; index < model.materials.length; index++) if (!usedMaterials.has(index)) {
    const material = model.materials[index], pbr = material?.pbrMetallicRoughness || {};
    check(material && typeof material === 'object' && !Array.isArray(material) && typeof pbr === 'object' && !Array.isArray(pbr)
      && Object.keys(material).every(key => ['name','pbrMetallicRoughness','alphaMode','alphaCutoff','doubleSided','emissiveFactor'].includes(key))
      && Object.keys(pbr).every(key => ['baseColorFactor','metallicFactor','roughnessFactor'].includes(key)), 'unreferenced_material_image');
    check(material.name === undefined || typeof material.name === 'string' && material.name.length <= 1024, 'unreferenced_material_image');
    check(material.alphaMode === undefined || ['OPAQUE','MASK','BLEND'].includes(material.alphaMode), 'unreferenced_material_image');
    check(material.doubleSided === undefined || typeof material.doubleSided === 'boolean', 'unreferenced_material_image');
    for (const [values, length] of [[pbr.baseColorFactor,4], [material.emissiveFactor,3]])
      check(values === undefined || Array.isArray(values) && values.length === length
        && values.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'unreferenced_material_image');
    for (const value of [pbr.metallicFactor, pbr.roughnessFactor, material.alphaCutoff])
      check(value === undefined || Number.isFinite(value) && value >= 0 && value <= 1, 'unreferenced_material_image');
    unusedUntexturedMaterials.push(index);
  }
  return { images, unusedUntexturedMaterials, triangleCount: triangles, *triangles() {
    for (const primitive of primitives) for (let at = 0; at < primitive.indices.count; at += 3) {
      if (at % 3072 === 0) checkpoint();
      const vertices = [0,1,2].map(corner => {
        const index = primitive.indices.get(at + corner);
        return [primitive.positions.get(index,0), primitive.positions.get(index,1), primitive.positions.get(index,2), primitive.uv.get(index,0), primitive.uv.get(index,1)];
      });
      yield { atlasIdentity: primitive.image.name, vertices };
    }
  } };
}

function faceKey(name, vertices) {
  basename(name); check(vertices.length === 3 && vertices.every(vertex => vertex.length === 5), 'face_shape');
  const words = vertices.map(vertex => {
    const bytes = Buffer.allocUnsafe(20);
    vertex.forEach((value, index) => {
      const rounded = Math.fround(value); check(Number.isFinite(rounded), 'face_nonfinite');
      bytes.writeFloatLE(rounded === 0 ? 0 : rounded, index * 4); // signed zero has identical geometry/UV meaning
    });
    return bytes.toString('hex');
  });
  const canonical = words.map((_, i) => [...words.slice(i), ...words.slice(0,i)].join('')).sort()[0];
  return crypto.createHash('sha256').update('ltds-emitted-uv-material-v1\0').update(name).update('\0').update(canonical).digest('hex');
}

// Stream records, retain only bounded key multiplicities. Never substitute this
// join for original-source UV verification, V4 geometry or actual pixel decoding.
export async function matchDeclaredFaces(tile, records, { checkpoint = () => {} } = {}) {
  const expected = new Map(); let declared = 0;
  for await (const record of records) {
    checkpoint(); check(record && typeof record === 'object' && !Array.isArray(record), 'mapping_shape');
    if (record.recordType !== 'face') continue;
    check(++declared <= ASSOCIATION_LIMITS.triangles && Array.isArray(record.triangle) && record.triangle.length === 9
      && record.triangle.every(Number.isFinite) && Array.isArray(record.atlasUv) && record.atlasUv.length === 6
      && record.atlasUv.every(Number.isFinite), 'mapping_shape');
    const vertices = [0,1,2].map(i => [...record.triangle.slice(i * 3, i * 3 + 3).map(Math.fround),
      Math.fround(record.atlasUv[i * 2]), Math.fround(1 - Math.fround(record.atlasUv[i * 2 + 1]))]);
    const key = faceKey(record.atlasIdentity, vertices); expected.set(key, (expected.get(key) || 0) + 1);
  }
  check(declared === tile.triangleCount, 'mapping_multiplicity');
  let emitted = 0;
  for (const triangle of tile.triangles()) {
    if (emitted % 1024 === 0) checkpoint();
    const key = faceKey(triangle.atlasIdentity, triangle.vertices), count = expected.get(key);
    check(count > 0, 'emitted_uv_material_mismatch');
    if (count === 1) expected.delete(key); else expected.set(key, count - 1);
    emitted++;
  }
  check(expected.size === 0 && emitted === declared, 'mapping_multiplicity');
  return { declaredTriangles: declared, emittedTriangles: emitted, scope: 'emitted-to-declared position/UV/material multiplicity only' };
}
