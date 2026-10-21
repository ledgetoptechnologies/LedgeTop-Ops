import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import draco3d from 'draco3d';
import { BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import converterPolicy from '../../lod-converter-policy.cjs';
import { inspectLodTileset } from '../../lod-policy.mjs';

export const AUDIT_ALGORITHM = 'ltds-glb-leaf-equivalence-v2';
export const CONTROLLED_AUDIT_ALGORITHM = 'ltds-obj2tiles-surface-equivalence-v3';
export const CONTROLLED_AUDIT_ALGORITHM_V4 = 'ltds-obj2tiles-surface-equivalence-v4';
export const CONTROLLED_CONVERTER = converterPolicy.CONTROLLED_CONVERTER;
export const CONTROLLED_CONVERTER_BINARY_SHA256 = converterPolicy.CONTROLLED_CONVERTER_BINARY_SHA256;
export const CONTROLLED_CONVERTER_COMMAND_SHA256 = converterPolicy.CONTROLLED_CONVERTER_COMMAND_SHA256;
export const SERIAL_RETRY_CONVERTER = converterPolicy.SERIAL_RETRY_CONVERTER;
export const SERIAL_RETRY_CONVERTER_COMMAND_SHA256 = converterPolicy.SERIAL_RETRY_CONVERTER_COMMAND_SHA256;
export const CONTROLLED_SURFACE_AUDIT_POLICY_V4 = converterPolicy.CONTROLLED_SURFACE_AUDIT_POLICY_V4;
export const DEFAULT_TOLERANCE = 1e-6;
const CONTROLLED_SAMPLE_COUNT = 16_384;
const CONTROLLED_RELATIVE_SURFACE_TOLERANCE = 2e-5;

const dracoDecoderModule = draco3d.createDecoderModule({});

export function auditFailureExitCode(error) {
  if (error?.code === 'lod_surface_equivalence_failed') return 3;
  return typeof error?.code === 'string' && error.code ? 4 : 3;
}

function surfaceEquivalenceError(message, details) {
  return Object.assign(new Error(message), {
    code: 'lod_surface_equivalence_failed',
    details,
  });
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const IDENTITY = new Matrix4();
// 3D Tiles is Z-up while embedded glTF is Y-up. Compare in the source GLB's
// Y-up frame by conjugating the accumulated tile/RTC transform.
const GLTF_TO_TILE = new Matrix4().makeRotationX(Math.PI / 2);
const TILE_TO_GLTF = GLTF_TO_TILE.clone().invert();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function localPath(root, base, uri) {
  if (typeof uri !== 'string' || !uri || /^(?:[a-z]+:)?\/\//i.test(uri)) {
    throw new Error(`remote or empty asset URI is not auditable (${uri || '<empty>'})`);
  }
  if (uri.startsWith('data:')) return null;
  const resolved = path.resolve(base, decodeURIComponent(uri.split(/[?#]/, 1)[0]));
  if (!inside(root, resolved)) throw new Error(`asset URI escapes the audit root (${uri})`);
  return resolved;
}

function dataUri(uri) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!match) throw new Error('malformed data URI');
  return Buffer.from(match[3], match[2] ? 'base64' : 'utf8');
}

function parseGlb(buffer, label) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`${label}: GLB magic is missing`);
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`${label}: only GLB 2.0 is supported`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error(`${label}: GLB byteLength does not match the file`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > buffer.length) throw new Error(`${label}: GLB chunk exceeds byteLength`);
    if (type === 0x4e4f534a && !json) json = JSON.parse(buffer.subarray(offset, offset + length).toString('utf8').trim());
    if (type === 0x004e4942 && !bin) bin = buffer.subarray(offset, offset + length);
    offset += length;
  }
  if (!json) throw new Error(`${label}: GLB JSON chunk is missing`);
  return { json, bin: bin || Buffer.alloc(0) };
}

function parseB3dm(buffer, label) {
  if (buffer.length < 28 || buffer.toString('ascii', 0, 4) !== 'b3dm') throw new Error(`${label}: B3DM header is missing`);
  if (buffer.readUInt32LE(4) !== 1) throw new Error(`${label}: only B3DM version 1 is supported`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error(`${label}: B3DM byteLength does not match the file`);
  const ftJsonLength = buffer.readUInt32LE(12);
  const ftBinLength = buffer.readUInt32LE(16);
  const btJsonLength = buffer.readUInt32LE(20);
  const btBinLength = buffer.readUInt32LE(24);
  const glbOffset = 28 + ftJsonLength + ftBinLength + btJsonLength + btBinLength;
  if (glbOffset >= buffer.length) throw new Error(`${label}: embedded GLB is missing`);
  if (glbOffset + 12 > buffer.length || buffer.readUInt32LE(glbOffset) !== 0x46546c67) {
    throw new Error(`${label}: embedded GLB header is missing`);
  }
  const glbLength = buffer.readUInt32LE(glbOffset + 8);
  if (glbLength < 20 || glbOffset + glbLength > buffer.length) {
    throw new Error(`${label}: embedded GLB byteLength is invalid`);
  }
  const trailing = buffer.subarray(glbOffset + glbLength);
  if (trailing.length > 7 || trailing.some((value) => value !== 0 && value !== 0x20)) {
    throw new Error(`${label}: embedded GLB has invalid B3DM alignment padding`);
  }
  let rtc = null;
  if (ftJsonLength) {
    const feature = JSON.parse(buffer.subarray(28, 28 + ftJsonLength).toString('utf8').trim());
    if (feature.RTC_CENTER !== undefined) {
      if (!Array.isArray(feature.RTC_CENTER) || feature.RTC_CENTER.length !== 3
        || feature.RTC_CENTER.some((value) => !Number.isFinite(value))) {
        throw new Error(`${label}: binary or malformed RTC_CENTER is not supported by v2`);
      }
      rtc = feature.RTC_CENTER;
    }
  }
  return { glb: buffer.subarray(glbOffset, glbOffset + glbLength), rtc };
}

function nodeMatrix(node) {
  if (Array.isArray(node.matrix)) {
    if (node.matrix.length !== 16 || node.matrix.some((value) => !Number.isFinite(value))) throw new Error('invalid node matrix');
    return new Matrix4().fromArray(node.matrix);
  }
  const translation = Array.isArray(node.translation) ? node.translation : [0, 0, 0];
  const rotation = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1];
  const scale = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
  return new Matrix4().compose(
    new Vector3(...translation),
    new Quaternion(...rotation),
    new Vector3(...scale),
  );
}

function readComponent(buffer, offset, type, normalized) {
  let value;
  if (type === 5120) value = buffer.readInt8(offset);
  else if (type === 5121) value = buffer.readUInt8(offset);
  else if (type === 5122) value = buffer.readInt16LE(offset);
  else if (type === 5123) value = buffer.readUInt16LE(offset);
  else if (type === 5125) value = buffer.readUInt32LE(offset);
  else if (type === 5126) value = buffer.readFloatLE(offset);
  else throw new Error(`unsupported accessor componentType ${type}`);
  if (!normalized || type === 5126 || type === 5125) return value;
  if (type === 5120) return Math.max(value / 127, -1);
  if (type === 5121) return value / 255;
  if (type === 5122) return Math.max(value / 32767, -1);
  return value / 65535;
}

function normalizeComponent(value, type, normalized) {
  if (!normalized || type === 5126 || type === 5125) return value;
  if (type === 5120) return Math.max(value / 127, -1);
  if (type === 5121) return value / 255;
  if (type === 5122) return Math.max(value / 32767, -1);
  return value / 65535;
}

async function dracoPrimitiveValues(asset, primitive, label) {
  const extension = primitive.extensions?.KHR_draco_mesh_compression;
  if (!extension) return null;
  const view = asset.json.bufferViews?.[extension.bufferView];
  if (!view || (view.buffer ?? 0) !== 0 || view.extensions?.EXT_meshopt_compression) {
    throw new Error(`${label}: Draco bufferView is missing, external, or nested-compressed`);
  }
  const start = view.byteOffset || 0;
  const end = start + view.byteLength;
  if (start < 0 || end > asset.bin.length) throw new Error(`${label}: Draco bufferView exceeds the GLB buffer`);

  const module = await dracoDecoderModule;
  const decoder = new module.Decoder();
  const decoderBuffer = new module.DecoderBuffer();
  const mesh = new module.Mesh();
  let status = null;
  try {
    const encoded = asset.bin.subarray(start, end);
    decoderBuffer.Init(new Int8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength), encoded.byteLength);
    if (decoder.GetEncodedGeometryType(decoderBuffer) !== module.TRIANGULAR_MESH) {
      throw new Error(`${label}: Draco primitive is not a triangular mesh`);
    }
    status = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
    if (!status?.ok?.()) throw new Error(`${label}: Draco decode failed (${status?.error_msg?.() || 'unknown error'})`);

    const attributes = {};
    const decodedMethods = {
      5120: ['DracoInt8Array', 'GetAttributeInt8ForAllPoints'],
      5121: ['DracoUInt8Array', 'GetAttributeUInt8ForAllPoints'],
      5122: ['DracoInt16Array', 'GetAttributeInt16ForAllPoints'],
      5123: ['DracoUInt16Array', 'GetAttributeUInt16ForAllPoints'],
      5125: ['DracoUInt32Array', 'GetAttributeUInt32ForAllPoints'],
      5126: ['DracoFloat32Array', 'GetAttributeFloatForAllPoints'],
    };
    for (const [semantic, uniqueId] of Object.entries(extension.attributes || {})) {
      const accessorIndex = primitive.attributes?.[semantic];
      const accessor = asset.json.accessors?.[accessorIndex];
      const componentCount = COMPONENTS[accessor?.type];
      const method = decodedMethods[accessor?.componentType];
      if (!Number.isInteger(accessorIndex) || !accessor || accessor.sparse || !componentCount || !method
        || !Number.isInteger(accessor.count) || accessor.count !== mesh.num_points()) {
        throw new Error(`${label}: Draco attribute ${semantic} has an unsupported or inconsistent accessor`);
      }
      const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId);
      if (!attribute?.ptr || attribute.num_components() !== componentCount) {
        throw new Error(`${label}: Draco attribute ${semantic} is missing or has the wrong width`);
      }
      const values = new module[method[0]]();
      try {
        if (!decoder[method[1]](mesh, attribute, values)) throw new Error(`${label}: Draco attribute ${semantic} could not be decoded`);
        if (values.size() !== accessor.count * componentCount) throw new Error(`${label}: Draco attribute ${semantic} has the wrong decoded length`);
        attributes[semantic] = Array.from({ length: accessor.count }, (_, row) => (
          Array.from({ length: componentCount }, (_, component) => normalizeComponent(
            values.GetValue(row * componentCount + component),
            accessor.componentType,
            accessor.normalized,
          ))
        ));
      } finally {
        module.destroy(values);
      }
    }
    const expectedAttributes = Object.keys(primitive.attributes || {}).sort();
    if (expectedAttributes.some((semantic) => !attributes[semantic])) {
      throw new Error(`${label}: Draco extension does not bind every primitive attribute`);
    }

    const indexAccessor = asset.json.accessors?.[primitive.indices];
    if (!Number.isInteger(primitive.indices) || !indexAccessor || indexAccessor.type !== 'SCALAR'
      || !Number.isInteger(indexAccessor.count) || indexAccessor.count !== mesh.num_faces() * 3) {
      throw new Error(`${label}: Draco indices accessor is missing or inconsistent`);
    }
    const face = new module.DracoInt32Array();
    const indices = [];
    try {
      for (let faceIndex = 0; faceIndex < mesh.num_faces(); faceIndex += 1) {
        if (!decoder.GetFaceFromMesh(mesh, faceIndex, face) || face.size() !== 3) {
          throw new Error(`${label}: Draco face ${faceIndex} could not be decoded`);
        }
        for (let component = 0; component < 3; component += 1) indices.push(face.GetValue(component));
      }
    } finally {
      module.destroy(face);
    }
    return { attributes, indices };
  } finally {
    if (status) module.destroy(status);
    module.destroy(mesh);
    module.destroy(decoderBuffer);
    module.destroy(decoder);
  }
}

function accessorValues(asset, index, label) {
  const accessor = asset.json.accessors?.[index];
  if (!accessor) throw new Error(`${label}: accessor ${index} is missing`);
  if (accessor.sparse) throw new Error(`${label}: sparse accessors are not supported by the exact audit`);
  const componentCount = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!componentCount || !componentBytes || !Number.isInteger(accessor.count) || accessor.count < 0) {
    throw new Error(`${label}: accessor ${index} has an unsupported layout`);
  }
  const view = asset.json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`${label}: accessor ${index} has no bufferView`);
  if (view.extensions?.EXT_meshopt_compression) throw new Error(`${label}: meshopt-compressed accessors are not supported`);
  if ((view.buffer ?? 0) !== 0) throw new Error(`${label}: only an embedded GLB buffer is supported`);
  const packed = componentCount * componentBytes;
  const stride = view.byteStride || packed;
  if (stride < packed) throw new Error(`${label}: accessor ${index} has an invalid byteStride`);
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const end = accessor.count ? start + (accessor.count - 1) * stride + packed : start;
  if (start < 0 || end > asset.bin.length) throw new Error(`${label}: accessor ${index} exceeds the GLB buffer`);
  const values = [];
  for (let row = 0; row < accessor.count; row += 1) {
    const item = [];
    for (let component = 0; component < componentCount; component += 1) {
      item.push(readComponent(asset.bin, start + row * stride + component * componentBytes, accessor.componentType, accessor.normalized));
    }
    values.push(item);
  }
  return values;
}

function resolveImage(asset, imageIndex, label) {
  const image = asset.json.images?.[imageIndex];
  if (!image) throw new Error(`${label}: image ${imageIndex} is missing`);
  let bytes;
  if (Number.isInteger(image.bufferView)) {
    const view = asset.json.bufferViews?.[image.bufferView];
    if (!view || (view.buffer ?? 0) !== 0) throw new Error(`${label}: image bufferView is invalid or external`);
    bytes = asset.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  } else if (typeof image.uri === 'string') {
    const imagePath = localPath(asset.root, asset.baseDir, image.uri);
    if (imagePath) {
      bytes = fs.readFileSync(imagePath);
      asset.bindExternal?.(imagePath, bytes);
    } else {
      bytes = dataUri(image.uri);
    }
  } else {
    throw new Error(`${label}: image ${imageIndex} has no auditable payload`);
  }
  return { sha256: sha256(bytes), byteLength: bytes.length, mimeType: image.mimeType || null };
}

function textureDescriptor(asset, index, label) {
  const texture = asset.json.textures?.[index];
  if (!texture) throw new Error(`${label}: texture ${index} is missing`);
  const basisu = texture.extensions?.KHR_texture_basisu;
  if (texture.extensions?.EXT_texture_webp
    || (basisu && !asset.allowCompressedTextureSources)) {
    throw new Error(`${label}: alternate compressed texture sources are not supported by v2`);
  }
  const source = basisu?.source ?? texture.source;
  if (!Number.isInteger(source)) throw new Error(`${label}: texture ${index} has no auditable image source`);
  const sampler = asset.json.samplers?.[texture.sampler] || {};
  return {
    image: resolveImage(asset, source, label),
    sampler: {
      magFilter: sampler.magFilter ?? 9729,
      minFilter: sampler.minFilter ?? 9987,
      wrapS: sampler.wrapS ?? 10497,
      wrapT: sampler.wrapT ?? 10497,
    },
  };
}

function resolveTextureInfos(value, asset, label, key = '') {
  if (Array.isArray(value)) return value.map((entry) => resolveTextureInfos(entry, asset, label, key));
  if (!value || typeof value !== 'object') return value;
  if (/texture$/i.test(key) && Number.isInteger(value.index)) {
    const { index, ...properties } = value;
    return { ...resolveTextureInfos(properties, asset, label), texture: textureDescriptor(asset, index, label) };
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => name !== 'name' && name !== 'extras')
    .map(([name, child]) => [name, resolveTextureInfos(child, asset, label, name)]));
}

function materialSignature(asset, index, label) {
  const material = Number.isInteger(index) ? asset.json.materials?.[index] : null;
  if (Number.isInteger(index) && !material) throw new Error(`${label}: material ${index} is missing`);
  const pbr = material?.pbrMetallicRoughness || {};
  const semantic = {
    pbrMetallicRoughness: {
      baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
      baseColorTexture: pbr.baseColorTexture || null,
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      metallicRoughnessTexture: pbr.metallicRoughnessTexture || null,
    },
    normalTexture: material?.normalTexture || null,
    occlusionTexture: material?.occlusionTexture || null,
    emissiveTexture: material?.emissiveTexture || null,
    emissiveFactor: material?.emissiveFactor || [0, 0, 0],
    alphaMode: material?.alphaMode || 'OPAQUE',
    alphaCutoff: material?.alphaCutoff ?? 0.5,
    doubleSided: material?.doubleSided || false,
    extensions: material?.extensions || null,
  };
  return stable(resolveTextureInfos(semantic, asset, label));
}

function transformAttribute(name, value, world, normalMatrix) {
  if (name === 'POSITION') {
    const vector = new Vector3(value[0], value[1], value[2]).applyMatrix4(world);
    return [vector.x, vector.y, vector.z];
  }
  if (name === 'NORMAL') {
    const vector = new Vector3(value[0], value[1], value[2]).applyMatrix3(normalMatrix).normalize();
    return [vector.x, vector.y, vector.z];
  }
  if (name === 'TANGENT') {
    const vector = new Vector3(value[0], value[1], value[2]).applyMatrix3(normalMatrix).normalize();
    return [vector.x, vector.y, vector.z, value[3]];
  }
  return value;
}

function orderedNumber(value, tolerance) {
  return tolerance > 0 ? Math.round(value / tolerance) : value;
}

function compareVectors(a, b, tolerance = 0) {
  const length = Math.min(a.values.length, b.values.length);
  for (let index = 0; index < length; index += 1) {
    const left = orderedNumber(a.values[index], tolerance);
    const right = orderedNumber(b.values[index], tolerance);
    if (left !== right) return left - right;
  }
  return a.values.length - b.values.length || a.keys.localeCompare(b.keys);
}

function rotateCanonical(vertices, tolerance = 0) {
  const rotations = [vertices, [vertices[1], vertices[2], vertices[0]], [vertices[2], vertices[0], vertices[1]]];
  rotations.sort((a, b) => {
    for (let index = 0; index < 3; index += 1) {
      const compared = compareVectors(a[index], b[index], tolerance);
      if (compared) return compared;
    }
    return 0;
  });
  return rotations[0];
}

function triangleCompare(a, b, tolerance = 0) {
  const material = a.material.localeCompare(b.material);
  if (material) return material;
  for (let index = 0; index < 3; index += 1) {
    const compared = compareVectors(a.vertices[index], b.vertices[index], tolerance);
    if (compared) return compared;
  }
  return 0;
}

async function extractTriangles(asset, rootTransform, label) {
  const triangles = [];
  const nodes = asset.json.nodes || [];
  const childNodes = new Set(nodes.flatMap((node) => node.children || []));
  const scene = asset.json.scenes?.[asset.json.scene ?? 0];
  const roots = scene?.nodes || nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
  const active = new Set();

  async function visit(nodeIndex, parent) {
    if (active.has(nodeIndex)) throw new Error(`${label}: node hierarchy contains a cycle`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`${label}: node ${nodeIndex} is missing`);
    if (node.skin !== undefined || node.weights || node.extensions?.EXT_mesh_gpu_instancing) {
      throw new Error(`${label}: skinned, morphed, or instanced geometry is not supported by v2`);
    }
    active.add(nodeIndex);
    const world = parent.clone().multiply(nodeMatrix(node));
    if (Number.isInteger(node.mesh)) {
      const mesh = asset.json.meshes?.[node.mesh];
      if (!mesh) throw new Error(`${label}: mesh ${node.mesh} is missing`);
      for (const primitive of mesh.primitives || []) {
        if ((primitive.mode ?? 4) !== 4) throw new Error(`${label}: only TRIANGLES primitives are auditable`);
        if (primitive.targets?.length) throw new Error(`${label}: morph targets are not supported by v2`);
        if (!Number.isInteger(primitive.attributes?.POSITION)) throw new Error(`${label}: primitive has no POSITION accessor`);
        const suppliedAttributeNames = Object.keys(primitive.attributes).sort();
        if (suppliedAttributeNames.some((name) => name.startsWith('JOINTS_') || name.startsWith('WEIGHTS_'))) {
          throw new Error(`${label}: skinned attributes are not supported by v2`);
        }
        const attributeNames = suppliedAttributeNames.filter((name) => (
          name === 'POSITION' || name === 'NORMAL' || name === 'TANGENT'
          || /^TEXCOORD_\d+$/.test(name) || /^COLOR_\d+$/.test(name)
        ));
        const unsupported = suppliedAttributeNames.filter((name) => !attributeNames.includes(name) && !name.startsWith('_'));
        if (unsupported.length) throw new Error(`${label}: unsupported render attribute ${unsupported[0]}`);
        const draco = await dracoPrimitiveValues(asset, primitive, label);
        const attributes = draco?.attributes || Object.fromEntries(attributeNames.map((name) => [name, accessorValues(asset, primitive.attributes[name], label)]));
        const vertexCount = attributes.POSITION.length;
        if (Object.values(attributes).some((values) => values.length !== vertexCount)) throw new Error(`${label}: primitive attributes have different counts`);
        const indices = draco?.indices || (Number.isInteger(primitive.indices)
          ? accessorValues(asset, primitive.indices, label).map((value) => value[0])
          : Array.from({ length: vertexCount }, (_, index) => index));
        if (indices.length % 3) throw new Error(`${label}: triangle index count is not divisible by three`);
        const determinant = world.determinant();
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-15) throw new Error(`${label}: singular or invalid geometry transform`);
        const normalMatrix = new Matrix3().getNormalMatrix(world);
        const material = materialSignature(asset, primitive.material, label);
        for (let offset = 0; offset < indices.length; offset += 3) {
          const vertices = [];
          for (const index of indices.slice(offset, offset + 3)) {
            if (!Number.isInteger(index) || index < 0 || index >= vertexCount) throw new Error(`${label}: primitive index is out of bounds`);
            const values = [];
            let position = null;
            for (const name of attributeNames) {
              const transformed = transformAttribute(name, attributes[name][index], world, normalMatrix);
              values.push(...transformed);
              if (name === 'POSITION') position = transformed.slice(0, 3);
            }
            vertices.push({ keys: attributeNames.join('|'), values, position });
          }
          if (determinant < 0) [vertices[1], vertices[2]] = [vertices[2], vertices[1]];
          triangles.push({ material, vertices: rotateCanonical(vertices) });
        }
      }
    }
    for (const child of node.children || []) await visit(child, world);
    active.delete(nodeIndex);
  }

  let assetTransform = rootTransform;
  const cesiumRtc = asset.applyCesiumRtc === false ? undefined : asset.json.extensions?.CESIUM_RTC?.center;
  if (cesiumRtc !== undefined) {
    if (!Array.isArray(cesiumRtc) || cesiumRtc.length !== 3 || cesiumRtc.some((value) => !Number.isFinite(value))) {
      throw new Error(`${label}: malformed CESIUM_RTC center`);
    }
    assetTransform = rootTransform.clone().multiply(new Matrix4().makeTranslation(...cesiumRtc));
  }
  for (const root of roots) await visit(root, assetTransform);
  return triangles;
}

function loadGlbAsset(filePath, root, embeddedBuffer = null, bindExternal = null, applyCesiumRtc = true, allowCompressedTextureSources = false) {
  const label = path.relative(root, filePath) || path.basename(filePath);
  const parsed = parseGlb(embeddedBuffer || fs.readFileSync(filePath), label);
  if ((parsed.json.buffers || []).length > 1 || (parsed.json.buffers?.[0]?.uri)) {
    throw new Error(`${label}: only a single embedded GLB buffer is supported`);
  }
  const supportedExtension = (name) => name === 'CESIUM_RTC' || name === 'KHR_mesh_quantization'
    || name === 'KHR_draco_mesh_compression' || (allowCompressedTextureSources && name === 'KHR_texture_basisu')
    || name === 'KHR_texture_transform' || (/^KHR_materials_/.test(name) && name !== 'KHR_materials_variants');
  const unsupportedRequired = (parsed.json.extensionsRequired || []).find((name) => !supportedExtension(name));
  if (unsupportedRequired) throw new Error(`${label}: required extension ${unsupportedRequired} is not supported by v2`);
  return { ...parsed, root, baseDir: path.dirname(filePath), bindExternal, applyCesiumRtc, allowCompressedTextureSources };
}

async function collectLeafTriangles(derivativeDir, artifacts, { allowCompressedTextureSources = false } = {}) {
  const triangles = [];
  const visitedTilesets = new Set();

  function bindArtifact(filePath, knownBytes = null) {
    const relative = path.relative(derivativeDir, filePath).split(path.sep).join('/');
    let bytes = knownBytes;
    if (!bytes) {
      try {
        bytes = fs.readFileSync(filePath);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error?.code)) {
          throw new Error(`required tile artifact is missing or invalid (${relative})`);
        }
        throw error;
      }
    }
    artifacts.set(relative, { uri: relative, sha256: sha256(bytes), byteLength: bytes.length });
    return bytes;
  }

  async function walkTileset(filePath, inheritedTransform = IDENTITY) {
    const absolute = path.resolve(filePath);
    if (!inside(derivativeDir, absolute)) throw new Error(`external tileset escapes the derivative directory (${filePath})`);
    const visitKey = `${absolute}:${inheritedTransform.elements.join(',')}`;
    if (visitedTilesets.has(visitKey)) throw new Error(`tileset cycle detected at ${path.relative(derivativeDir, absolute)}`);
    visitedTilesets.add(visitKey);
    const bytes = bindArtifact(absolute);
    const tileset = JSON.parse(bytes.toString('utf8'));
    const report = inspectLodTileset(tileset);
    if (!report.valid) throw new Error(`${path.basename(absolute)}: ${report.errors[0]}`);

    async function walkTile(tile, parentTransform) {
      // Obj2Tiles emits `null` for inherited transforms. Treat that the same
      // as an omitted transform; both mean the parent's transform applies.
      if (tile.transform != null && (!Array.isArray(tile.transform) || tile.transform.length !== 16
        || tile.transform.some((value) => !Number.isFinite(value)))) {
        throw new Error('tile transform must contain 16 finite numbers');
      }
      const local = Array.isArray(tile.transform) ? new Matrix4().fromArray(tile.transform) : IDENTITY;
      const world = parentTransform.clone().multiply(local);
      const children = Array.isArray(tile.children) ? tile.children : [];
      if (children.length) {
        for (const child of children) await walkTile(child, world);
        return;
      }
      const uri = tile?.content?.uri || tile?.content?.url;
      if (!uri) throw new Error('zero-error terminal tile has no content');
      const contentPath = localPath(derivativeDir, path.dirname(absolute), uri);
      if (!contentPath) throw new Error(`data URI tile content is unsupported (${uri})`);
      if (/\.json$/i.test(contentPath)) {
        await walkTileset(contentPath, world);
        return;
      }
      const content = bindArtifact(contentPath);
      let glb = content;
      let rtc = null;
      if (/\.b3dm$/i.test(contentPath)) ({ glb, rtc } = parseB3dm(content, path.relative(derivativeDir, contentPath)));
      else if (!/\.glb$/i.test(contentPath)) throw new Error(`unsupported leaf content type (${uri})`);
      const tileContentTransform = rtc ? world.clone().multiply(new Matrix4().makeTranslation(...rtc)) : world;
      const contentTransform = TILE_TO_GLTF.clone().multiply(tileContentTransform).multiply(GLTF_TO_TILE);
      triangles.push(...await extractTriangles(
        loadGlbAsset(contentPath, derivativeDir, glb, bindArtifact, true, allowCompressedTextureSources),
        contentTransform,
        uri,
      ));
    }

    await walkTile(tileset.root, inheritedTransform);
    visitedTilesets.delete(visitKey);
  }

  await walkTileset(path.join(derivativeDir, 'tileset.json'));
  return { triangles, artifacts: [...artifacts.values()].sort((a, b) => a.uri.localeCompare(b.uri)) };
}

function compareAudits(source, leaves, tolerance) {
  for (const triangle of source) triangle.vertices = rotateCanonical(triangle.vertices, tolerance);
  for (const triangle of leaves) triangle.vertices = rotateCanonical(triangle.vertices, tolerance);
  source.sort((a, b) => triangleCompare(a, b, tolerance));
  leaves.sort((a, b) => triangleCompare(a, b, tolerance));
  let maxNumericDelta = 0;
  const compareTriangleValues = (a, b, triangleIndex) => {
    if (a.material !== b.material) throw new Error(`material/texture evidence differs at canonical triangle ${triangleIndex}`);
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      if (a.vertices[vertexIndex].keys !== b.vertices[vertexIndex].keys) {
        throw new Error(`vertex attribute set differs at canonical triangle ${triangleIndex}`);
      }
      const av = a.vertices[vertexIndex].values;
      const bv = b.vertices[vertexIndex].values;
      if (av.length !== bv.length) throw new Error(`vertex attribute width differs at canonical triangle ${triangleIndex}`);
      for (let component = 0; component < av.length; component += 1) {
        const delta = Math.abs(av[component] - bv[component]);
        if (!Number.isFinite(delta) || delta > tolerance) {
          throw new Error(`geometry/attribute delta ${delta} exceeds tolerance ${tolerance} at canonical triangle ${triangleIndex}`);
        }
        maxNumericDelta = Math.max(maxNumericDelta, delta);
      }
    }
  };

  // Obj2Tiles assigns a triangle that straddles a spatial partition to each
  // adjoining leaf. Those are byte/material-equivalent duplicate draw calls,
  // not new surface geometry. Compare canonical triangle multisets and permit
  // only additional exact opaque copies. This deliberately does not accept
  // clipping, retriangulation, missing triangles, or area/bounds-only matches.
  // Area and bounds alone are not an integrity proof: unrelated geometry can
  // preserve both. Transparent duplicates are rejected because overdraw can
  // change their rendered appearance.
  let sourceIndex = 0;
  let leafIndex = 0;
  let duplicateLeafTriangleCount = 0;
  while (sourceIndex < source.length || leafIndex < leaves.length) {
    if (sourceIndex >= source.length || leafIndex >= leaves.length
      || triangleCompare(source[sourceIndex], leaves[leafIndex], tolerance) !== 0) {
      throw new Error(`canonical triangle coverage differs: source=${source.length}, leaves=${leaves.length}`);
    }
    const representative = source[sourceIndex];
    let sourceEnd = sourceIndex + 1;
    while (sourceEnd < source.length && triangleCompare(representative, source[sourceEnd], tolerance) === 0) sourceEnd += 1;
    let leafEnd = leafIndex + 1;
    while (leafEnd < leaves.length && triangleCompare(representative, leaves[leafEnd], tolerance) === 0) leafEnd += 1;
    const sourceCopies = sourceEnd - sourceIndex;
    const leafCopies = leafEnd - leafIndex;
    if (leafCopies < sourceCopies) {
      throw new Error(`canonical triangle multiplicity is reduced: source=${sourceCopies}, leaves=${leafCopies}`);
    }
    if (leafCopies > sourceCopies && representative.material.includes('"alphaMode":"BLEND"')) {
      throw new Error('transparent canonical triangle is duplicated across leaves');
    }
    for (let index = sourceIndex; index < sourceEnd; index += 1) compareTriangleValues(representative, source[index], index);
    for (let index = leafIndex; index < leafEnd; index += 1) compareTriangleValues(representative, leaves[index], sourceIndex);
    duplicateLeafTriangleCount += leafCopies - sourceCopies;
    sourceIndex = sourceEnd;
    leafIndex = leafEnd;
  }
  const canonical = source.map((triangle) => ({ material: triangle.material, vertices: triangle.vertices }));
  return {
    maxNumericDelta,
    equivalenceSha256: sha256(stable(canonical)),
    leafTriangleCount: leaves.length,
    duplicateLeafTriangleCount,
  };
}

function trianglePositions(triangle) {
  const positions = triangle.vertices.map((vertex) => vertex.position);
  if (positions.some((position) => !Array.isArray(position) || position.length !== 3
    || position.some((value) => !Number.isFinite(value)))) {
    throw new Error('controlled surface audit encountered a non-finite position');
  }
  return positions;
}

function materialTraits(material) {
  let parsed;
  try {
    parsed = JSON.parse(material);
  } catch {
    throw new Error('controlled surface audit encountered malformed material evidence');
  }
  return {
    alphaMode: parsed.alphaMode,
    textured: Boolean(parsed.pbrMetallicRoughness?.baseColorTexture?.texture?.image),
  };
}

function assertControlledRenderCoverage(triangles, label) {
  let textured = 0;
  let opaque = 0;
  let uv = 0;
  let normals = 0;
  for (const triangle of triangles) {
    const keys = triangle.vertices[0]?.keys?.split('|') || [];
    if (keys.includes('TEXCOORD_0')) uv += 1;
    if (keys.includes('NORMAL')) normals += 1;
    const traits = materialTraits(triangle.material);
    if (traits.textured) textured += 1;
    if (traits.alphaMode === 'OPAQUE') opaque += 1;
  }
  if (uv !== triangles.length) throw new Error(`${label} does not retain TEXCOORD_0 on every full-detail triangle`);
  if (textured !== triangles.length) throw new Error(`${label} does not retain textured base-color material coverage`);
  if (opaque !== triangles.length) throw new Error(`${label} introduces non-opaque full-detail material coverage`);
  return { triangleCount: triangles.length, texturedTriangleCount: textured, uvTriangleCount: uv, normalTriangleCount: normals };
}

function compensatedAccumulator() {
  return { sum: 0, correction: 0 };
}

function compensatedAdd(accumulator, value) {
  const next = accumulator.sum + value;
  accumulator.correction += Math.abs(accumulator.sum) >= Math.abs(value)
    ? (accumulator.sum - next) + value
    : (value - next) + accumulator.sum;
  accumulator.sum = next;
}

function compensatedValue(accumulator) {
  return accumulator.sum + accumulator.correction;
}

function surfaceStatisticsPass(triangles, origin, reverse = false) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const areaAccumulator = compensatedAccumulator();
  const firstMomentAccumulators = Array.from({ length: 3 }, compensatedAccumulator);
  const secondMomentAccumulators = Array.from({ length: 6 }, compensatedAccumulator);
  let degenerateTriangleCount = 0;
  for (let position = 0; position < triangles.length; position += 1) {
    const triangle = triangles[reverse ? triangles.length - position - 1 : position];
    const points = trianglePositions(triangle).map((point) => point.map((value, axis) => value - origin[axis]));
    for (const point of points) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
    const ab = new Vector3(...points[1]).sub(new Vector3(...points[0]));
    const ac = new Vector3(...points[2]).sub(new Vector3(...points[0]));
    const triangleArea = ab.cross(ac).length() / 2;
    if (!Number.isFinite(triangleArea)) throw new Error('controlled surface audit encountered a non-finite triangle area');
    if (triangleArea <= 1e-18) {
      degenerateTriangleCount += 1;
      continue;
    }
    compensatedAdd(areaAccumulator, triangleArea);
    const sum = [0, 1, 2].map((axis) => points[0][axis] + points[1][axis] + points[2][axis]);
    for (let axis = 0; axis < 3; axis += 1) compensatedAdd(firstMomentAccumulators[axis], triangleArea * sum[axis] / 3);
    const pairs = [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]];
    for (let index = 0; index < pairs.length; index += 1) {
      const [left, right] = pairs[index];
      const diagonal = points.reduce((total, point) => total + point[left] * point[right], 0);
      compensatedAdd(secondMomentAccumulators[index], triangleArea * (sum[left] * sum[right] + diagonal) / 12);
    }
  }
  const area = compensatedValue(areaAccumulator);
  if (!(area > 0)) throw new Error('controlled surface audit found no non-degenerate surface area');
  const firstMoment = firstMomentAccumulators.map(compensatedValue);
  const secondMoment = secondMomentAccumulators.map(compensatedValue);
  const centroid = firstMoment.map((value) => value / area);
  const normalizedSecondMoment = secondMoment.map((value) => value / area);
  return { minimum, maximum, area, firstMoment, secondMoment, centroid, normalizedSecondMoment, degenerateTriangleCount };
}

function numericAgreement(left, right) {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1);
}

function surfaceStatistics(triangles, origin) {
  const forward = surfaceStatisticsPass(triangles, origin, false);
  const reverse = surfaceStatisticsPass(triangles, origin, true);
  const numericalAgreement = {
    areaRelativeDelta: numericAgreement(forward.area, reverse.area),
    firstMomentRelativeDelta: maximumDelta(forward.firstMoment, reverse.firstMoment)
      / Math.max(1, ...forward.firstMoment.map(Math.abs), ...reverse.firstMoment.map(Math.abs)),
    secondMomentRelativeDelta: maximumDelta(forward.secondMoment, reverse.secondMoment)
      / Math.max(1, ...forward.secondMoment.map(Math.abs), ...reverse.secondMoment.map(Math.abs)),
  };
  numericalAgreement.maximumRelativeDelta = Math.max(
    numericalAgreement.areaRelativeDelta,
    numericalAgreement.firstMomentRelativeDelta,
    numericalAgreement.secondMomentRelativeDelta,
  );
  if (numericalAgreement.maximumRelativeDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.numericalAgreementLimit) {
    throw surfaceEquivalenceError(
      `controlled surface accumulation is numerically unstable (${numericalAgreement.maximumRelativeDelta})`,
      {
        metric: 'forwardReverseNumericalAgreement',
        observed: numericalAgreement.maximumRelativeDelta,
        limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.numericalAgreementLimit,
      },
    );
  }
  return { ...forward, numericalAgreement };
}

function maximumDelta(left, right) {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index])));
}

function relativeDelta(left, right, scale = 1) {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), scale);
}

function deterministicTriangleIndices(count, requested, seed) {
  const take = Math.min(count, requested);
  if (take === count) return Array.from({ length: count }, (_, index) => index);
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  const selected = new Set();
  while (selected.size < take) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    selected.add(state % count);
  }
  return [...selected].sort((a, b) => a - b);
}

function makeSurfaceBvh(triangles, origin) {
  const positions = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const triangle of triangles) {
    for (const point of trianglePositions(triangle)) {
      positions[offset++] = point[0] - origin[0];
      positions[offset++] = point[1] - origin[1];
      positions[offset++] = point[2] - origin[2];
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const bvh = new MeshBVH(geometry, { targetLeafSize: 20 });
  return { bvh, geometry };
}

function faceNormal(triangle) {
  const [a, b, c] = trianglePositions(triangle).map((point) => new Vector3(...point));
  return b.sub(a).cross(c.sub(a)).normalize();
}

function geometryFaceNormal(geometry, faceIndex) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const indices = index
    ? [index.getX(faceIndex * 3), index.getX(faceIndex * 3 + 1), index.getX(faceIndex * 3 + 2)]
    : [faceIndex * 3, faceIndex * 3 + 1, faceIndex * 3 + 2];
  const [a, b, c] = indices.map((vertex) => new Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex)));
  return b.sub(a).cross(c.sub(a)).normalize();
}

function samplePoint(points, sample) {
  const weights = sample === 0 ? [1 / 3, 1 / 3, 1 / 3]
    : sample === 1 ? [0.6, 0.2, 0.2]
      : sample === 2 ? [0.2, 0.6, 0.2] : [0.2, 0.2, 0.6];
  return new Vector3(
    points.reduce((sum, point, index) => sum + point[0] * weights[index], 0),
    points.reduce((sum, point, index) => sum + point[1] * weights[index], 0),
    points.reduce((sum, point, index) => sum + point[2] * weights[index], 0),
  );
}

function auditSurfaceDirection(source, targetSurface, origin, seed, tolerance) {
  const requestedTriangles = Math.max(1, Math.floor(CONTROLLED_SAMPLE_COUNT / 4));
  const indices = deterministicTriangleIndices(source.length, requestedTriangles, seed);
  let maximumDistance = 0;
  let minimumNormalDot = 1;
  let reversedNormalSampleCount = 0;
  let sampleCount = 0;
  for (const index of indices) {
    const sourceTriangle = source[index];
    const points = trianglePositions(sourceTriangle).map((point) => point.map((value, axis) => value - origin[axis]));
    const sourceNormal = faceNormal(sourceTriangle);
    for (let sample = 0; sample < 4; sample += 1) {
      const closest = targetSurface.bvh.closestPointToPoint(samplePoint(points, sample), {});
      if (!closest || !Number.isFinite(closest.distance) || !Number.isInteger(closest.faceIndex)) {
        throw new Error('controlled surface BVH query did not return a finite nearest point');
      }
      maximumDistance = Math.max(maximumDistance, closest.distance);
      const dot = sourceNormal.dot(geometryFaceNormal(targetSurface.geometry, closest.faceIndex));
      minimumNormalDot = Math.min(minimumNormalDot, dot);
      if (!Number.isFinite(dot)) throw new Error('controlled surface orientation sample is non-finite');
      if (dot < 0) reversedNormalSampleCount += 1;
      sampleCount += 1;
    }
  }
  const reversedNormalFraction = reversedNormalSampleCount / sampleCount;
  return { sampleCount, maximumDistance, minimumNormalDot, reversedNormalSampleCount, reversedNormalFraction };
}

function controlledSurfaceComparison(source, leaves, sourceSha256) {
  const sourceRender = assertControlledRenderCoverage(source, 'source GLB');
  const leafRender = assertControlledRenderCoverage(leaves, 'controlled Obj2Tiles frontier');
  const absoluteMinimum = [Infinity, Infinity, Infinity];
  const absoluteMaximum = [-Infinity, -Infinity, -Infinity];
  for (const triangle of source) {
    for (const point of trianglePositions(triangle)) {
      for (let axis = 0; axis < 3; axis += 1) {
        absoluteMinimum[axis] = Math.min(absoluteMinimum[axis], point[axis]);
        absoluteMaximum[axis] = Math.max(absoluteMaximum[axis], point[axis]);
      }
    }
  }
  const origin = absoluteMinimum.map((value, axis) => (value + absoluteMaximum[axis]) / 2);
  const sourceStats = surfaceStatistics(source, origin);
  const leafStats = surfaceStatistics(leaves, origin);
  const diagonal = Math.hypot(...sourceStats.maximum.map((value, axis) => value - sourceStats.minimum[axis]));
  const surfaceTolerance = Math.max(DEFAULT_TOLERANCE, diagonal * CONTROLLED_RELATIVE_SURFACE_TOLERANCE);
  const boundsDelta = Math.max(maximumDelta(sourceStats.minimum, leafStats.minimum), maximumDelta(sourceStats.maximum, leafStats.maximum));
  const areaRelativeDelta = relativeDelta(sourceStats.area, leafStats.area, diagonal * diagonal);
  const centroidDelta = maximumDelta(sourceStats.centroid, leafStats.centroid);
  const momentScale = Math.max(diagonal * diagonal, 1);
  const momentDelta = maximumDelta(sourceStats.normalizedSecondMoment, leafStats.normalizedSecondMoment) / momentScale;

  const sourceSurface = makeSurfaceBvh(source, origin);
  const leafSurface = makeSurfaceBvh(leaves, origin);
  try {
    const sourceToLeaves = auditSurfaceDirection(source, leafSurface, origin, `${sourceSha256}01`, surfaceTolerance);
    const leavesToSource = auditSurfaceDirection(leaves, sourceSurface, origin, `${sourceSha256}10`, surfaceTolerance);
    const maximumSurfaceDistance = Math.max(sourceToLeaves.maximumDistance, leavesToSource.maximumDistance);
    const maximumReversedNormalFraction = Math.max(sourceToLeaves.reversedNormalFraction, leavesToSource.reversedNormalFraction);
    const normalFailures = [];
    if (boundsDelta > surfaceTolerance) normalFailures.push({ metric: 'boundsDelta', observed: boundsDelta, limit: surfaceTolerance });
    if (centroidDelta > surfaceTolerance) normalFailures.push({ metric: 'centroidDelta', observed: centroidDelta, limit: surfaceTolerance });
    if (momentDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalNormalizedSecondMomentDeltaLimit) normalFailures.push({
      metric: 'normalizedSecondMomentDelta', observed: momentDelta, limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalNormalizedSecondMomentDeltaLimit,
    });
    if (maximumSurfaceDistance > surfaceTolerance) normalFailures.push({ metric: 'maximumSurfaceDistance', observed: maximumSurfaceDistance, limit: surfaceTolerance });
    if (maximumReversedNormalFraction > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalMaximumReversedNormalFraction) normalFailures.push({
      metric: 'maximumReversedNormalFraction', observed: maximumReversedNormalFraction, limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalMaximumReversedNormalFraction,
    });

    let acceptance = 'normal';
    if (areaRelativeDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalAreaRelativeDeltaLimit) {
      acceptance = 'gray-zone';
      const graySpatialLimit = surfaceTolerance * CONTROLLED_SURFACE_AUDIT_POLICY_V4.graySpatialToleranceFraction;
      const grayFailures = [];
      if (areaRelativeDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit) grayFailures.push({
        metric: 'areaRelativeDelta', observed: areaRelativeDelta, limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit,
      });
      if (boundsDelta > graySpatialLimit) grayFailures.push({ metric: 'boundsDelta', observed: boundsDelta, limit: graySpatialLimit });
      if (centroidDelta > graySpatialLimit) grayFailures.push({ metric: 'centroidDelta', observed: centroidDelta, limit: graySpatialLimit });
      if (momentDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayNormalizedSecondMomentDeltaLimit) grayFailures.push({
        metric: 'normalizedSecondMomentDelta', observed: momentDelta, limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayNormalizedSecondMomentDeltaLimit,
      });
      for (const [direction, evidence] of [['sourceToLeaves', sourceToLeaves], ['leavesToSource', leavesToSource]]) {
        if (evidence.maximumDistance > graySpatialLimit) grayFailures.push({
          metric: `${direction}.maximumDistance`, observed: evidence.maximumDistance, limit: graySpatialLimit,
        });
        if (evidence.reversedNormalFraction > CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayMaximumReversedNormalFraction) grayFailures.push({
          metric: `${direction}.reversedNormalFraction`, observed: evidence.reversedNormalFraction, limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayMaximumReversedNormalFraction,
        });
      }
      if (grayFailures.length) {
        throw surfaceEquivalenceError(`controlled surface area differs by ${areaRelativeDelta}`, {
          metric: 'areaRelativeDelta',
          observed: areaRelativeDelta,
          limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalAreaRelativeDeltaLimit,
          grayZoneLimit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit,
          grayZoneGateFailures: grayFailures,
        });
      }
    } else if (normalFailures.length) {
      const first = normalFailures[0];
      throw surfaceEquivalenceError(`controlled surface ${first.metric} exceeds policy (${first.observed})`, {
        ...first,
        failures: normalFailures,
      });
    }

    return {
      sourceRender,
      leafRender,
      sourceStats,
      leafStats,
      origin,
      diagonal,
      surfaceTolerance,
      boundsDelta,
      areaRelativeDelta,
      centroidDelta,
      momentDelta,
      acceptance,
      sourceToLeaves,
      leavesToSource,
    };
  } finally {
    sourceSurface.geometry.dispose();
    leafSurface.geometry.dispose();
  }
}

export async function auditLodEquivalence({ derivativeDir, sourceGlb, tolerance = DEFAULT_TOLERANCE, allowExternalSource = false }) {
  derivativeDir = path.resolve(derivativeDir);
  sourceGlb = path.resolve(sourceGlb);
  if (!allowExternalSource && !inside(derivativeDir, sourceGlb)) {
    throw new Error('source GLB must be inside the derivative directory so the runtime can bind it to the audit');
  }
  if (!/\.glb$/i.test(sourceGlb)) throw new Error('v1 equivalence auditing supports a GLB source only');
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1e-3) throw new Error('tolerance must be between 0 and 0.001 model units');
  const sourceBytes = fs.readFileSync(sourceGlb);
  const artifactMap = new Map();
  const bindExternal = (filePath, knownBytes = null) => {
    const relative = path.relative(derivativeDir, filePath).split(path.sep).join('/');
    const bytes = knownBytes || fs.readFileSync(filePath);
    artifactMap.set(relative, { uri: relative, sha256: sha256(bytes), byteLength: bytes.length });
    return bytes;
  };
  const source = await extractTriangles(
    loadGlbAsset(sourceGlb, derivativeDir, sourceBytes, bindExternal),
    IDENTITY,
    path.basename(sourceGlb),
  );
  const { triangles: leaves } = await collectLeafTriangles(derivativeDir, artifactMap);
  const artifacts = [...artifactMap.values()].sort((a, b) => a.uri.localeCompare(b.uri));
  const comparison = compareAudits(source, leaves, tolerance);
  return {
    schemaVersion: 2,
    sourceAsset: path.basename(sourceGlb),
    sourceSha256: sha256(sourceBytes),
    geometry: 'bounded-triangle-equivalence',
    textures: 'byte-identical-material-equivalence',
    leafGeometricError: 0,
    audit: {
      algorithm: AUDIT_ALGORITHM,
      coordinateTolerance: tolerance,
      maxNumericDelta: comparison.maxNumericDelta,
      triangleCount: source.length,
      leafTriangleCount: comparison.leafTriangleCount,
      duplicateLeafTriangleCount: comparison.duplicateLeafTriangleCount,
      equivalenceSha256: comparison.equivalenceSha256,
      artifacts,
    },
  };
}

export async function auditControlledObj2Tiles({
  derivativeDir,
  sourceGlb,
  converterInput,
  converterBinary,
  allowExternalSource = false,
  trustedConverterBinarySha256 = CONTROLLED_CONVERTER_BINARY_SHA256,
  converterSerialRetry = false,
}) {
  derivativeDir = path.resolve(derivativeDir);
  sourceGlb = path.resolve(sourceGlb);
  converterInput = path.resolve(converterInput || '');
  converterBinary = path.resolve(converterBinary || '');
  if (!allowExternalSource && (![sourceGlb, converterInput, converterBinary].every((candidate) => inside(derivativeDir, candidate)))) {
    throw new Error('controlled converter inputs must be inside the derivative directory unless external inputs are explicitly enabled');
  }
  if (!/\.glb$/i.test(sourceGlb)) throw new Error('controlled Obj2Tiles auditing requires a GLB reference source');
  if (!/\.obj$/i.test(converterInput)) throw new Error('controlled Obj2Tiles auditing requires the exact OBJ converter input');
  const [sourceBytes, converterInputSha256, converterBinarySha256] = await Promise.all([
    fs.promises.readFile(sourceGlb),
    sha256File(converterInput),
    sha256File(converterBinary),
  ]);
  const sourceDigest = sha256(sourceBytes);
  if (!Array.isArray(trustedConverterBinarySha256) || !trustedConverterBinarySha256.includes(converterBinarySha256)) {
    throw new Error(`converter binary SHA-256 is not an approved Obj2Tiles ${CONTROLLED_CONVERTER.version} executable`);
  }
  const artifactMap = new Map();
  const bindExternal = (filePath, knownBytes = null) => {
    const relative = path.relative(derivativeDir, filePath).split(path.sep).join('/');
    const bytes = knownBytes || fs.readFileSync(filePath);
    artifactMap.set(relative, { uri: relative, sha256: sha256(bytes), byteLength: bytes.length });
    return bytes;
  };
  const source = await extractTriangles(
    loadGlbAsset(sourceGlb, derivativeDir, sourceBytes, bindExternal, false),
    IDENTITY,
    path.basename(sourceGlb),
  );
  const { triangles: leaves } = await collectLeafTriangles(derivativeDir, artifactMap, {
    allowCompressedTextureSources: true,
  });
  const artifacts = [...artifactMap.values()].sort((a, b) => a.uri.localeCompare(b.uri));
  const comparison = controlledSurfaceComparison(source, leaves, sourceDigest);
  const converterContract = converterSerialRetry ? SERIAL_RETRY_CONVERTER : CONTROLLED_CONVERTER;
  const commandSha256 = converterSerialRetry
    ? SERIAL_RETRY_CONVERTER_COMMAND_SHA256
    : CONTROLLED_CONVERTER_COMMAND_SHA256;
  const surfaceEvidence = {
    sourceTriangleCount: source.length,
    leafTriangleCount: leaves.length,
    sourceArea: comparison.sourceStats.area,
    leafArea: comparison.leafStats.area,
    sourceDegenerateTriangleCount: comparison.sourceStats.degenerateTriangleCount,
    leafDegenerateTriangleCount: comparison.leafStats.degenerateTriangleCount,
    accumulationMethod: CONTROLLED_SURFACE_AUDIT_POLICY_V4.accumulationMethod,
    numericalAgreement: {
      source: comparison.sourceStats.numericalAgreement,
      leaves: comparison.leafStats.numericalAgreement,
      maximumRelativeDelta: Math.max(
        comparison.sourceStats.numericalAgreement.maximumRelativeDelta,
        comparison.leafStats.numericalAgreement.maximumRelativeDelta,
      ),
    },
    boundsDelta: comparison.boundsDelta,
    areaRelativeDelta: comparison.areaRelativeDelta,
    centroidDelta: comparison.centroidDelta,
    normalizedSecondMomentDelta: comparison.momentDelta,
    coordinateOrigin: comparison.origin,
    diagonal: comparison.diagonal,
    surfaceTolerance: comparison.surfaceTolerance,
    sourceToLeaves: comparison.sourceToLeaves,
    leavesToSource: comparison.leavesToSource,
    sourceRender: comparison.sourceRender,
    leafRender: comparison.leafRender,
    acceptance: comparison.acceptance,
  };
  const converter = {
    ...converterContract,
    commandSha256,
    inputAsset: path.basename(converterInput),
    inputSha256: converterInputSha256,
    binarySha256: converterBinarySha256,
  };
  const policy = { ...CONTROLLED_SURFACE_AUDIT_POLICY_V4 };
  const equivalenceSha256 = sha256(stable({
    sourceSha256: sourceDigest,
    converter,
    policy,
    surfaceEvidence,
    artifacts,
  }));
  return {
    schemaVersion: 4,
    sourceAsset: path.basename(sourceGlb),
    sourceSha256: sourceDigest,
    geometry: 'controlled-bidirectional-surface-equivalence',
    textures: 'controlled-atlas-material-equivalence',
    leafGeometricError: 0,
    converter,
    audit: {
      algorithm: CONTROLLED_AUDIT_ALGORITHM_V4,
      policy,
      equivalenceSha256,
      ...surfaceEvidence,
      artifacts,
    },
  };
}

export async function writeLodProvenance({
  derivativeDir,
  sourceGlb,
  tolerance = DEFAULT_TOLERANCE,
  output,
  allowExternalSource = false,
  controlledObj2Tiles = false,
  converterSerialRetry = false,
  converterInput,
  converterBinary,
  trustedConverterBinarySha256,
}) {
  const provenance = controlledObj2Tiles
    ? await auditControlledObj2Tiles({ derivativeDir, sourceGlb, converterInput, converterBinary, allowExternalSource, trustedConverterBinarySha256, converterSerialRetry })
    : await auditLodEquivalence({ derivativeDir, sourceGlb, tolerance, allowExternalSource });
  const outputPath = path.resolve(output || path.join(derivativeDir, 'lod-provenance.json'));
  if (!inside(path.resolve(derivativeDir), outputPath)) throw new Error('provenance output must stay inside the derivative directory');
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  try {
    await fs.promises.rename(temporary, outputPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  return { provenance, outputPath };
}
