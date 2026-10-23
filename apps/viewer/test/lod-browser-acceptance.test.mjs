import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { createServer as createViteServer } from 'vite';
import { writeArrayBuffer } from 'geotiff';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { makeB3dm, makeGlb } from './helpers/lod-fixture.mjs';
import { workspaceConnectSources } from '../server/workspaceConnectPolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureId = 'lod-browser-fixture';
const GiB = 1024 * 1024 * 1024;
// Historical raw-SSE/focal/retention cases explicitly use lodDistanceDemand=0
// so their original quality assertions remain intact. Default-on behavior is
// covered separately by the depth-separated integration A/B below.

// Lossless one-source-pixel stripes expose enlargement of a fit-sized raster.
// A 1x1 fixture can verify routing, but cannot verify photo detail at native size.
function stripedPhotoPng(width, height) {
  const chunk = (type, body) => {
    const data = Buffer.concat([Buffer.from(type), body]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4);
    header.writeUInt32BE(body.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    pixels.fill(x % 2 ? 255 : 0, offset, offset + 3);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function assertPhotoPanBounds({ wrap, image }) {
  for (const [start, end] of [['l', 'r'], ['t', 'b']]) {
    if (image[end] - image[start] >= wrap[end] - wrap[start] - 2) {
      assert.ok(image[start] <= wrap[start] + 2 && image[end] >= wrap[end] - 2,
        `zoomed photo exposed excess background on ${start}/${end}: ${JSON.stringify({ wrap, image })}`);
    } else {
      assert.ok(Math.abs(image[start] + image[end] - wrap[start] - wrap[end]) <= 2,
        `letterboxed photo moved off center on ${start}/${end}: ${JSON.stringify({ wrap, image })}`);
    }
  }
}

async function assertExpandedPhotoWheelAndPan(client) {
  // Image decoding precedes the onload/layout callback, and CDP acknowledges
  // wheel dispatch before its DOM handler necessarily runs. Wait on observable
  // layout transitions rather than using a CSS transform as a zoom indicator.
  await waitFor(client, `(() => { const img=document.querySelector('#photo-img');
    return img.complete && img.naturalWidth>0 && getComputedStyle(img).opacity==='1'
      && img.getBoundingClientRect().width>0; })()`, 'expanded photo did not finish its initial layout', 10_000);
  const before = await client.evaluate(`(() => { const r=document.querySelector('#photo-imgwrap').getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,width:document.querySelector('#photo-img').getBoundingClientRect().width}; })()`);
  await client.command('Input.dispatchMouseEvent', { type:'mouseWheel', x:before.x, y:before.y, deltaX:0, deltaY:-420 });
  await waitFor(client, `document.querySelector('#photo-img').getBoundingClientRect().width > ${before.width * 1.1}`,
    'expanded wheel did not enlarge the painted camera photo', 5_000);
  const zoomed = await client.evaluate(`(() => {const r=document.querySelector('#photo-img').getBoundingClientRect();return {left:r.left,top:r.top};})()`);
  await client.command('Input.dispatchMouseEvent', { type:'mousePressed', x:before.x, y:before.y, button:'left', buttons:1, clickCount:1 });
  await client.command('Input.dispatchMouseEvent', { type:'mouseMoved', x:2, y:2, button:'left', buttons:1 });
  await client.command('Input.dispatchMouseEvent', { type:'mouseReleased', x:2, y:2, button:'left', buttons:0, clickCount:1 });
  await waitFor(client, `(() => {const r=document.querySelector('#photo-img').getBoundingClientRect();
    return Math.hypot(r.left-(${zoomed.left}),r.top-(${zoomed.top}))>1;})()`, 'expanded drag did not move the zoomed photo', 5_000);
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const after = await client.evaluate(`(() => {const w=document.querySelector('#photo-imgwrap').getBoundingClientRect(),i=document.querySelector('#photo-img').getBoundingClientRect();
    return {wrap:{l:w.left,t:w.top,r:w.right,b:w.bottom},image:{l:i.left,t:i.top,r:i.right,b:i.bottom}}; })()`);
  assert.ok(after.image.r-after.image.l > before.width*1.1, 'drag reset the photo zoom');
  assertPhotoPanBounds(after);
}

async function assertStableMapCameraAnchors(client) {
  // This fixture exercises the real Leaflet canvas layer without a GeoTIFF
  // response. These assertions prove camera anchoring, not raster rendering.
  await waitFor(client, `!document.querySelector('#leaflet-map .leaflet-zoom-anim')`, 'initial map zoom did not settle');
  await client.evaluate(`(() => {
    window.__mapPinCanvas=document.querySelector('.map-camera-canvas');
    window.__mapPinSources=window.__ltdsMapCamDrawToSource.slice();
  })()`);
  const read = () => client.evaluate(`(() => {
    return {sources:window.__ltdsMapCamDrawToSource.slice().sort((a,b)=>a-b),same:document.querySelector('.map-camera-canvas')===window.__mapPinCanvas,
      points:window.__ltdsMapCamPoints.slice().sort((a,b)=>a.source-b.source).map(point=>({...point,width:point.size}))};
  })()`);
  const before = await read(); assert.deepEqual(before.sources, [0, 1, 2]);
  for (const point of before.points) {
    assert.equal(point.height, point.width * 4 / 3);
    assert.ok(Number.isFinite(point.bearing), 'each pin retains its image-up bearing');
  }
  const separation = value => Math.hypot(value.points[2].x-value.points[0].x,value.points[2].y-value.points[0].y);
  await client.evaluate(`document.querySelector('.leaflet-control-zoom-in').click()`);
  try { await waitFor(client, `(() => {const points=window.__ltdsMapCamPoints.slice().sort((a,b)=>a.source-b.source);if(points.length!==3)return false;
    const a=points[0],b=points[2];
    return !document.querySelector('#leaflet-map .leaflet-zoom-anim') && Math.hypot(b.x-a.x,b.y-a.y)>${separation(before) + 0.25};})()`, 'map camera anchors did not follow map zoom', 4_000); }
  catch(error) { throw new Error(`${error.message}; before=${JSON.stringify(before)}; after=${JSON.stringify(await read())}; controls=${JSON.stringify(await client.evaluate(`({zoom:document.querySelector('.leaflet-control-zoom-in')?.outerHTML,map:document.querySelector('#leaflet-map')?.className})`))}`); }
  const zoomed = await read(); assert.equal(zoomed.same, true, 'map zoom recreated the source markers');
  assert.deepEqual(zoomed.sources, before.sources, 'map zoom changed source photo identities');
  assert.ok(Math.abs(separation(zoomed) - 2 * separation(before)) < 3, 'geographic marker separation must follow one map zoom level');
  for (let index=0;index<3;index++) {
    assert.ok(Math.abs(zoomed.points[index].width-before.points[index].width)<1 && Math.abs(zoomed.points[index].height-before.points[index].height)<1,
      'map zoom changed the pin icon dimensions');
  }
  const area = await client.evaluate(`(() => {const r=document.querySelector('#leaflet-map').getBoundingClientRect();return {x:r.left+r.width*.7,y:r.top+r.height*.7};})()`);
  await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:area.x,y:area.y,button:'left',buttons:1,clickCount:1});
  await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:area.x+70,y:area.y+45,button:'left',buttons:1});
  await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:area.x+70,y:area.y+45,button:'left',buttons:0,clickCount:1});
  await waitFor(client, `(() => {const point=window.__ltdsMapCamPoints.find(point=>point.source===0);return point&&Math.hypot(point.x-${zoomed.points[0].x},point.y-${zoomed.points[0].y})>20;})()`, 'map drag did not move its source anchors');
  const panned = await read(); assert.equal(panned.same, true, 'map drag recreated source markers');
  assert.deepEqual(panned.sources, before.sources);
  for (let index=1;index<3;index++) {
    assert.ok(Math.abs((panned.points[index].x-zoomed.points[index].x)-(panned.points[0].x-zoomed.points[0].x))<2
      && Math.abs((panned.points[index].y-zoomed.points[index].y)-(panned.points[0].y-zoomed.points[0].y))<2,
    'map pan changed relative source camera locations');
  }
  // Leaflet deliberately suppresses the click immediately after a drag. Start
  // a fresh stationary pointer sequence before the later marker-click check.
  await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:area.x,y:area.y,button:'left',buttons:1,clickCount:1});
  await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:area.x,y:area.y,button:'left',buttons:0,clickCount:1});
  if (process.env.LTDS_PHOTO_QA_ARTIFACT_DIR) {
    const shot=await client.command('Page.captureScreenshot',{format:'png'});
    writeFileSync(path.join(process.env.LTDS_PHOTO_QA_ARTIFACT_DIR,'ortho-camera-pins-qa.png'),Buffer.from(shot.data,'base64'));
  }
}

// Use the production server's actual header expression, not a permissive test
// approximation. Importing index.js would also start its DB and HTTP listener.
function productionCspHeader() {
  const source = readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const match = source.match(/res\.setHeader\('Content-Security-Policy', (\[[\s\S]*?\]\.join\('; '\))\);/);
  assert.ok(match, 'Production CSP header layout changed; update the exact browser test adapter');
  const header = runInNewContext(match[1], {
    frameAncestors: "'self'", workspaceConnectSources,
    req: { path: '/view/token' }, config: { opsBaseUrl: 'https://ops.ledgetopdroneservices.com' },
  });
  assert.doesNotMatch(header, /https:\/\/ops\.ledgetopdroneservices\.com/);
  assert.match(header, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(header, /(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
  return header;
}

async function removeBrowserProfile(profile) {
  if (!profile) return;
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  // Edge can retain a Windows file handle briefly after its process exits.
  // The isolated OS temp profile is non-authoritative test scratch; cleanup
  // must never strand the cross-process browser lock or mask UI assertions.
  if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(lastError?.code)) return;
  throw lastError;
}

function browserPath() {
  return [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find(existsSync) || null;
}

function fixtureConfig() {
  const base = `/assets/${fixtureId}/derivatives`;
  return {
    id: fixtureId,
    title: 'LOD browser fixture',
    displayUnits: 'imperial',
    assets: {
      glb: `${base}/odm_textured_model_geo.glb`,
      obj: null,
      tiles: `${base}/tileset.json`,
      shots: `${base}/shots.geojson`,
      cameraPhotos: `${base}/camera-photos`,
      ortho: null,
      dsm: null,
      dtm: null,
      ept: null,
      pointCloud: null,
      pointCloudFormat: null,
    },
    lodProvenance: {
      schemaVersion: 2,
      sourceAsset: 'odm_textured_model_geo.glb',
      sourceSha256: 'a'.repeat(64),
      geometry: 'bounded-triangle-equivalence',
      textures: 'byte-identical-material-equivalence',
      leafGeometricError: 0,
      audit: {
        algorithm: 'ltds-glb-leaf-equivalence-v2',
        triangleCount: 1,
        equivalenceSha256: 'b'.repeat(64),
        coordinateTolerance: 0.0001,
        maxNumericDelta: 0,
        artifactCount: 2,
      },
    },
    georef: {
      rtc: { e: 367257, n: 4759982, z: 0 },
      bboxCenter: { x: -10.998394, y: -30.590805, z: 202.373772 },
      utmZoneLon0Deg: -87,
    },
  };
}

function focusOwnerTilesetFixture() {
  const translation = x => [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, 0, 0, 1,
  ];
  const box = halfWidth => [
    0, 0, 0,
    halfWidth, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ];
  const branch = (name, x) => ({
    transform: translation(x),
    boundingVolume: { box: box(1) },
    geometricError: 32,
    refine: 'REPLACE',
    content: { uri: `${name}/root.b3dm` },
    children: [{
      boundingVolume: { box: box(1) },
      geometricError: 0,
      refine: 'REPLACE',
      content: { uri: `${name}/leaf.b3dm` },
    }],
  });
  return {
    asset: { version: '1.0' },
    geometricError: 128,
    root: {
      boundingVolume: { box: box(6) },
      geometricError: 128,
      refine: 'REPLACE',
      content: { uri: 'root.b3dm' },
      children: [branch('a', -4), branch('b', 4)],
    },
  };
}

function foregroundAcceptanceFixture({
  worldCenterY = 18,
  boundaryGrid = false,
  alternateBranches = false,
} = {}) {
  const scaleAndTranslate = (scale, x, y) => [
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    x, y, 0, 1,
  ];
  const unitBox = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 0.2,
  ];
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const tileBytes = makeB3dm(makeGlb([
    [[-1, -1, 0], [1, -1, 0], [-1, 1, 0]],
    [[1, -1, 0], [1, 1, 0], [-1, 1, 0]],
  ], validPng));
  const assetBodies = {
    'coarse/root.b3dm': tileBytes,
  };
  const xs = boundaryGrid ? [-48, -16, 16, 48] : [-36, -12, 12, 36];
  const ys = [-24, -8, 8, 24];
  const tileScale = boundaryGrid ? 8 : 10;
  const positions = ys.flatMap(y => xs.map(x => [x, y]));
  if (alternateBranches) positions.push([-88, -16], [-88, 16], [88, -16], [88, 16]);
  const children = [];
  let index = 0;
  for (const [x, y] of positions) {
    const suffix = String(index).padStart(2, '0');
    const shellUri = `shell-${suffix}/root.b3dm`;
    const leafUri = `LOD-0/Mesh-${suffix}.b3dm`;
    assetBodies[shellUri] = tileBytes;
    assetBodies[leafUri] = tileBytes;
    children.push({
      transform: scaleAndTranslate(tileScale, x, y),
      boundingVolume: { box: unitBox },
      geometricError: 0.75,
      refine: 'REPLACE',
      content: { uri: shellUri },
      children: [{
        boundingVolume: { box: unitBox },
        geometricError: 0,
        refine: 'REPLACE',
        content: { uri: leafUri },
      }],
    });
    index += 1;
  }
  return {
    tilesetJson: {
      asset: { version: '1.0' },
      geometricError: 64,
      root: {
        boundingVolume: {
          box: [
            0, 0, 0,
            alternateBranches ? 98 : boundaryGrid ? 58 : 50, 0, 0,
            0, 36, 0,
            0, 0, 2,
          ],
        },
        geometricError: 64,
        refine: 'REPLACE',
        content: { uri: 'coarse/root.b3dm' },
        children,
      },
    },
    assetBodies,
    configureConfig(config) {
      // The generated hierarchy is centered at local (0, 0, 0). Pick the
      // georeference offset that maps it to the test's documented world-space
      // model center after the renderer and tilesParent axis corrections.
      config.georef.bboxCenter = { x: 0, y: 0, z: -worldCenterY };
    },
  };
}

// Unlike the flat acceptance grid, these are actual depth-stacked surfaces.
// The near wall stays in view while a pitch reveals a tall, cold rear wall.
// gltfUpAxis=Z keeps content and bounds in the same authored frame; the inverse
// pi-X coordinates below account for the Viewer's tilesParent transform.
function depthStackedAcceptanceFixture({ sameOwner = false, twoNear = false } = {}) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const local = ([x, y, z]) => [x, -y, -z];
  const rectangle = (left, right, bottom, top, z) => [
    [[left, bottom, z], [right, bottom, z], [left, top, z]].map(local),
    [[right, bottom, z], [right, top, z], [left, top, z]].map(local),
  ];
  const bounds = (left, right, bottom, top, front, back = front) => ({ box: [
    (left + right) / 2, -(bottom + top) / 2, -(front + back) / 2,
    (right - left) / 2, 0, 0,
    0, (top - bottom) / 2, 0,
    0, 0, Math.max(0.05, Math.abs(front - back) / 2),
  ] });
  const assetBodies = {};
  const logicalMiB = {};
  const addContent = (uri, triangles, miB) => {
    assetBodies[uri] = makeB3dm(makeGlb(triangles, png));
    logicalMiB[uri] = miB;
    return { uri };
  };
  const nearTriangles = [];
  const nearPoints = [];
  const nearRegions = (twoNear ? [[-12, -6], [6, 12]] : [[-6, 6]]).map(([leftEdge, rightEdge], regionIndex) => {
    const name = regionIndex === 0 ? 'near' : 'near-right';
    const triangles = rectangle(leftEdge, rightEdge, -3, 3, 0);
    nearTriangles.push(...triangles);
    return {
      boundingVolume: bounds(leftEdge, rightEdge, -3, 3, 0),
      geometricError: 0.5,
      refine: 'REPLACE',
      content: addContent(`${name}/region.b3dm`, triangles, sameOwner ? 32 : 64),
      children: Array.from({ length: 4 }, (_, index) => {
        const width = (rightEdge - leftEdge) / 4;
        const left = leftEdge + index * width;
        // Do not place the multi-wall ray probes exactly on each rectangle's
        // triangle diagonal: floating-point edge hits can miss both triangles.
        nearPoints.push(twoNear ? [left + width * 0.37, 0.4, 0] : [left + width / 2, 0, 0]);
        return {
          boundingVolume: bounds(left, left + width, -3, 3, 0),
          geometricError: 0,
          refine: 'REPLACE',
          content: addContent(`${name}/fine-${index}.b3dm`, rectangle(left, left + width, -3, 3, 0), 160),
        };
      }),
    };
  });
  const rearTriangles = [];
  const rear = [55, 67].flatMap((centerY, row) => [-12, -6, 0, 6, 12].map((centerX, column) => {
    const name = `rear-${row}-${column}`;
    const left = centerX - 3;
    const bottom = centerY - 5;
    const triangles = rectangle(left, left + 6, bottom, bottom + 10, -60);
    rearTriangles.push(...triangles);
    return {
      boundingVolume: bounds(left, left + 6, bottom, bottom + 10, -60),
      geometricError: 1,
      refine: 'REPLACE',
      content: addContent(`${name}/region.b3dm`, triangles, sameOwner ? 32 : 100),
      children: Array.from({ length: 4 }, (_, index) => {
        const leafLeft = left + index * 1.5;
        return {
          boundingVolume: bounds(leafLeft, leafLeft + 1.5, bottom, bottom + 10, -60),
          geometricError: 0,
          refine: 'REPLACE',
          content: addContent(`${name}/fine-${index}.b3dm`, rectangle(leafLeft, leafLeft + 1.5, bottom, bottom + 10, -60), 96),
        };
      }),
    };
  }));
  const allTriangles = [...nearTriangles, ...rearTriangles];
  const regions = [...nearRegions, ...rear];
  return {
    assetBodies,
    logicalMiB,
    nearUris: nearRegions.flatMap(region => region.children.map(tile => tile.content.uri)),
    nearPoints,
    rearPoints: [55, 67].flatMap(y => [-12, -6, 0, 6, 12].map(x => [x, y, -60])),
    tilesetJson: {
      asset: { version: '1.0', gltfUpAxis: 'Z' },
      geometricError: 128,
      root: {
        boundingVolume: bounds(-15, 15, -3, 72, 0, -60),
        geometricError: 128,
        refine: 'REPLACE',
        content: addContent('coarse/root.b3dm', allTriangles, 32),
        children: sameOwner ? [{
          boundingVolume: bounds(-15, 15, -3, 72, 0, -60),
          geometricError: 64,
          refine: 'REPLACE',
          content: addContent('combined/owner.b3dm', allTriangles, 512),
          children: regions,
        }] : regions,
      },
    },
    configureConfig(config) {
      config.georef.bboxCenter = { x: 0, y: 0, z: 0 };
    },
  };
}

function contentType(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.b3dm')) return 'application/octet-stream';
  return 'application/octet-stream';
}

async function startFixture(tileRoot, {
  assetDelayMs = () => 0,
  forceOptimizeDeps = false,
  tilesetJson = null,
  assetAliases = {},
  assetBodies = {},
  configureConfig = null,
  contentSecurityPolicy = null,
  productionBuild = false,
  cameraPhotoBodies = null,
} = {}) {
  const vite = productionBuild ? null : await createViteServer({
    root,
    appType: 'spa',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { force: forceOptimizeDeps },
  });
  const assetPrefix = `/assets/${fixtureId}/derivatives/`;
  const config = fixtureConfig();
  configureConfig?.(config);
  const requests = [];
  config.assets.ortho = '/fixtures/orthophoto.tif';
  const server = createServer((request, reply) => {
    if (contentSecurityPolicy) reply.setHeader('Content-Security-Policy', contentSecurityPolicy);
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/health') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) });
      reply.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/models') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify([config]));
      return;
    }
    if (url.pathname === `/api/models/${fixtureId}`) {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify(config));
      return;
    }
    if (['/api/share/photo-allowed', '/api/share/photo-staff', '/api/share/photo-denied'].includes(url.pathname)) {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify({ ...config, permissions: {
        measure: true, cameras: true, download: url.pathname.endsWith('photo-allowed'),
        cameraPhotoDownload: url.pathname.endsWith('photo-staff'),
      } }));
      return;
    }
    if (url.pathname === `${assetPrefix}shots.geojson`) {
      const center = config.georef.bboxCenter;
      const features = [0, 1, 2].map((index) => {
        const translation = [
          config.georef.rtc.e + center.x + index * 4,
          config.georef.rtc.n + center.y + index * 3,
          config.georef.rtc.z + center.z + 20 + index,
        ];
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: translation.slice() },
          properties: {
            translation,
            rotation: [0, 0, 0],
            filename: `photo-${index}.jpg`,
            capture_time: 1_775_577_600,
          },
        };
      });
      reply.writeHead(200, { 'Content-Type': 'application/geo+json; charset=utf-8' });
      reply.end(JSON.stringify({ type: 'FeatureCollection', features }));
      return;
    }
    if (url.pathname.startsWith(`${assetPrefix}camera-photos/`)) {
      const filename = decodeURIComponent(url.pathname.slice(`${assetPrefix}camera-photos/`.length));
      if (!/^photo-[0-2]\.jpg$/.test(filename)) { reply.writeHead(404); reply.end(); return; }
      const body = cameraPhotoBodies?.[filename] || Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8ZkAAAAASUVORK5CYII=', 'base64');
      reply.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      reply.end(body);
      return;
    }
    if (url.pathname.startsWith(assetPrefix)) {
      const relative = decodeURIComponent(url.pathname.slice(assetPrefix.length));
      if (relative === 'tileset.json' && tilesetJson) {
        const body = Buffer.from(JSON.stringify(tilesetJson));
        reply.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
        });
        reply.end(body);
        return;
      }
      if (Object.hasOwn(assetBodies, relative)) {
        const body = Buffer.from(assetBodies[relative]);
        const sendAsset = () => {
          if (reply.destroyed) return;
          reply.writeHead(200, { 'Content-Type': contentType(relative), 'Content-Length': body.length });
          reply.end(body);
        };
        const delayMs = Math.max(0, Number(assetDelayMs(relative)) || 0);
        if (delayMs > 0) setTimeout(sendAsset, delayMs);
        else sendAsset();
        return;
      }
      const sourceRelative = assetAliases[relative] || relative;
      const file = path.resolve(tileRoot, sourceRelative);
      if (!file.startsWith(`${tileRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        reply.writeHead(404);
        reply.end('not found');
        return;
      }
      const sendAsset = () => {
        if (reply.destroyed || !existsSync(file)) {
          reply.destroy();
          return;
        }
        reply.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': statSync(file).size });
        createReadStream(file).pipe(reply);
      };
      const delayMs = Math.max(0, Number(assetDelayMs(relative)) || 0);
      if (delayMs > 0) setTimeout(sendAsset, delayMs);
      else sendAsset();
      return;
    }
    if (productionBuild) {
      const dist = path.join(root, 'dist');
      const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        reply.writeHead(404); reply.end('not found'); return;
      }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
      reply.writeHead(200, { 'Content-Type': types[path.extname(file)] || contentType(file) });
      createReadStream(file).pipe(reply);
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, vite, requests, origin: `http://127.0.0.1:${server.address().port}` };
}

async function startStreamingOnlyFixture(assetOverrides = {}) {
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const requests = [];
  const config = fixtureConfig();
  config.assets.tiles = null;
  Object.assign(config.assets, assetOverrides);
  const orthophoto = Buffer.from(writeArrayBuffer(new Uint8Array([
    238,80,7, 255,150,48, 34,97,74, 109,190,140,
  ]), { width:2, height:2, SamplesPerPixel:3, BitsPerSample:[8,8,8],
    PhotometricInterpretation:2, PlanarConfiguration:1,
    ModelPixelScale:[20,20,0], ModelTiepoint:[0,0,0,367240,4760000,0], ProjectedCSTypeGeoKey:32616 }));
  const server = createServer((request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/health') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) });
      reply.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/models') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify([config]));
      return;
    }
    if (url.pathname === `/api/models/${fixtureId}`) {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify(config));
      return;
    }
    if (url.pathname === config.assets.glb) {
      reply.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': 4 });
      reply.end('GLB!');
      return;
    }
    if (url.pathname === config.assets.ortho) {
      // The streaming reader requires actual byte ranges, not SPA fallback
      // HTML or a successful status containing an invalid raster.
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), orthophoto.length-1) : orthophoto.length-1;
      if (start > end) { reply.writeHead(416, { 'Content-Range':`bytes */${orthophoto.length}` }); reply.end(); return; }
      reply.writeHead(range ? 206 : 200, { 'Content-Type':'image/tiff', 'Accept-Ranges':'bytes',
        'Content-Length':end-start+1, ...(range ? { 'Content-Range':`bytes ${start}-${end}/${orthophoto.length}` } : {}) });
      reply.end(orthophoto.subarray(start,end+1));
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, vite, requests, glbPath: config.assets.glb, origin: `http://127.0.0.1:${server.address().port}` };
}

async function startSessionRefreshFixture(tileRoot, { fineTileDelayMs = 0, shellTileDelayMs = 0 } = {}) {
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const requests = [];
  let currentRequests = 0;
  const config = fixtureConfig();
  const assetPrefix = `/session-assets/session-token/${fixtureId}/derivatives/`;
  config.assets.glb = `${assetPrefix}odm_textured_model_geo.glb`;
  config.assets.tiles = `${assetPrefix}tileset.json`;
  const server = createServer((request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/health') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) });
      reply.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/v1/sessions/current') {
      currentRequests += 1;
      const model = structuredClone(config);
      if (currentRequests === 1) model.assets.tiles = null;
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      reply.end(JSON.stringify({
        model,
        permissions: { view: true, measure: true, cameras: true },
        sessionId: 'refresh-session',
        accessToken: 'session-token',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        allowedEmbedOrigins: [],
      }));
      return;
    }
    if (url.pathname.startsWith(assetPrefix)) {
      const relative = decodeURIComponent(url.pathname.slice(assetPrefix.length));
      const file = path.resolve(tileRoot, relative);
      if (!file.startsWith(`${tileRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        reply.writeHead(404);
        reply.end('not found');
        return;
      }
      const sendAsset = () => {
        reply.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': statSync(file).size });
        createReadStream(file).pipe(reply);
      };
      if (shellTileDelayMs > 0 && /^mid-(?:a|b)\.glb$/i.test(relative)) {
        setTimeout(sendAsset, shellTileDelayMs);
      } else if (fineTileDelayMs > 0 && /^leaf-(?:a\.b3dm|b\.glb)$/i.test(relative)) {
        setTimeout(sendAsset, fineTileDelayMs);
      } else {
        sendAsset();
      }
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    vite,
    requests,
    glbPath: config.assets.glb,
    currentRequests: () => currentRequests,
    origin: `http://127.0.0.1:${server.address().port}`,
  };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  command(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 30_000) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() { this.socket.close(); }
}

async function waitFor(client, expression, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await client.evaluate(expression, Math.min(30_000, Math.max(1, deadline-Date.now()))); }
    catch (error) { throw new Error(`${message}; evaluation failed: ${error.message}`, { cause:error }); }
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}; last=${JSON.stringify(last)}`);
}

async function reserveDevToolsPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDevTools(port, browser) {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let lastState = 'connection was not accepted';
  while (Date.now() < deadline) {
    // Edge on Windows may hand the profile to a child and let its launcher
    // exit successfully. Only a failed exit or signal proves startup failed.
    if ((browser.exitCode !== null && browser.exitCode !== 0) || browser.signalCode !== null) {
      throw new Error(`browser exited before exposing DevTools (exit=${browser.exitCode}, signal=${browser.signalCode})`);
    }
    try {
      const response = await fetch(`${origin}/json/version`);
      if (response.ok) return origin;
      lastState = `DevTools returned HTTP ${response.status}`;
    } catch (error) {
      lastState = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`browser did not expose DevTools within 30 seconds: ${lastState}`);
}

function snapshotExpression() {
  return `(() => {
    const tiles = window.__ltds.tiles();
    const root = tiles?.root;
    const visibleLeaves = [];
    const attachedTiles = [];
    const renderedTiles = [];
    const attachedMaterials = [];
    const visit = (tile) => {
      if (!tile) return;
      const children = tile.children || [];
      if (children.length) children.forEach(visit);
      const attached = Boolean(tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene));
      let rendered = false;
      if (attached) {
        tile.engineData.scene.traverse((object) => {
          if (!object.isMesh || !object.material) return;
          for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
            if (material.visible !== false) rendered = true;
            attachedMaterials.push({
              visible: material.visible !== false,
              depthWrite: material.depthWrite,
              polygonOffset: material.polygonOffset,
              renderOrder: object.renderOrder,
              hasMap: Boolean(material.map),
              imageReady: Boolean(material.map && (material.map.image?.width || material.map.source?.data?.width)),
            });
          }
        });
        const row = { uri: tile.content?.uri || tile.content?.url || null, error: Number(tile.geometricError), rendered };
        attachedTiles.push(row);
        if (rendered) renderedTiles.push(row);
      }
      if (!children.length && Number(tile.geometricError) === 0 && rendered) {
        visibleLeaves.push(tile.content?.uri || tile.content?.url || null);
      }
    };
    visit(root);
    const materials = [];
    root?.engineData?.scene?.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        materials.push({
          visible: material.visible !== false,
          depthWrite: material.depthWrite,
          polygonOffset: material.polygonOffset,
          renderOrder: object.renderOrder,
          hasMap: Boolean(material.map),
          imageReady: Boolean(material.map && (material.map.image?.width || material.map.source?.data?.width)),
        });
      }
    });
    return {
      errorPanel: getComputedStyle(document.querySelector('#error-panel')).display,
      lodStatus: document.querySelector('#lod-status')?.textContent || '',
      profile: window.__ltds.state?.lodRuntimeProfile || null,
      manifestValid: window.__ltds.state?.lodManifestReport?.valid === true,
      root: {
        uri: root?.content?.uri || root?.content?.url || null,
        refine: root?.refine || null,
        visible: Boolean(root?.traversal?.visible && root?.engineData?.scene?.visible),
        attached: Boolean(root?.engineData?.scene && tiles?.group?.children?.includes(root.engineData.scene)),
        rendered: Boolean(root?.engineData?.scene && tiles?.group?.children?.includes(root.engineData.scene)
          && materials.some((material) => material.visible)),
        materials,
      },
      visibleLeaves,
      attachedTiles,
      renderedTiles,
      attachedMaterials,
      cache: { minBytesSize: tiles?.lruCache?.minBytesSize, maxBytesSize: tiles?.lruCache?.maxBytesSize, minSize: tiles?.lruCache?.minSize, maxSize: tiles?.lruCache?.maxSize, unloadPercent: tiles?.lruCache?.unloadPercent },
    };
  })()`;
}

function focusOwnerExpression() {
  return `(() => {
    const tiles = window.__ltds.tiles();
    const owner = tiles?.__ltdsFocusOwnerState?.owner;
    if (!owner) return null;
    const path = [];
    let cursor = owner;
    while (cursor && cursor !== tiles.root && cursor.parent) {
      path.unshift((cursor.parent.children || []).indexOf(cursor));
      cursor = cursor.parent;
    }
    const uri = owner.content?.uri || owner.content?.url || null;
    let overlap = Number(owner.__ltdsFocusOverlap) || 0;
    const visit = tile => {
      if (tile?.__ltdsFallbackOwner === owner) {
        overlap = Math.max(overlap, Number(tile.__ltdsFocusOverlap) || 0);
      }
      (tile?.children || []).forEach(visit);
    };
    visit(tiles.root);
    return {
      key: (path.length ? path.join('.') : 'root') + '|' + (uri || ''),
      uri,
      path,
      locked: owner.__ltdsFocalOwnerLocked === true,
      overlap,
      ownerView: tiles.__ltdsFocusOwnerState?.ownerView || null,
      currentView: tiles.__ltdsFocusOwnerState?.currentView || null,
    };
  })()`;
}

function foregroundCoverageExpression() {
  return `(() => {
    const tiles = window.__ltds.tiles();
    const root = tiles?.root;
    const rootScene = root?.engineData?.scene;
    const fineScenes = [];
    const visit = (tile) => {
      (tile?.children || []).forEach(visit);
      if (!(tile?.children || []).length && Number(tile?.geometricError) === 0
        && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) fineScenes.push(tile.engineData.scene);
    };
    visit(root);
    tiles?.group?.updateWorldMatrix(true, true);
    const Raycaster = window.__ltds.controls()._raycaster.constructor;
    const raycaster = new Raycaster();
    raycaster.firstHitOnly = true;
    const rows = [];
    let fineSamples = 0;
    for (const y of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
      for (const x of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
        raycaster.setFromCamera({ x, y }, window.__ltds.camera());
        const rootHit = Boolean(rootScene && raycaster.intersectObject(rootScene, true).length);
        const fineHit = Boolean(fineScenes.length && raycaster.intersectObjects(fineScenes, true).length);
        if (fineHit) fineSamples += 1;
        if (rootHit) rows.push({ x, y, fineHit });
      }
    }
    let rootRendered = false;
    rootScene?.traverse?.((object) => {
      if (!object.isMesh || !object.material) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (material.visible !== false) rootRendered = true;
      }
    });
    return {
      rootSamples: rows.length,
      fineSamples,
      fineScenes: fineScenes.length,
      rootAttached: Boolean(rootScene && tiles?.group?.children?.includes(rootScene)),
      rootRendered: rootRendered && Boolean(rootScene && tiles?.group?.children?.includes(rootScene)),
      rootOnly: rows.filter((row) => !row.fineHit),
      queueRunning: Boolean(tiles?.downloadQueue?.running || tiles?.parseQueue?.running),
    };
  })()`;
}

async function setView(client, position, lookAt) {
  await client.evaluate(`(() => {
    const Vector3 = window.__ltds.camera().position.constructor;
    window.__ltds.controls().setView(new Vector3(${position.join(',')}), new Vector3(${lookAt.join(',')}));
    return true;
  })()`);
}

async function setViewAtFirstCamera(client) {
  await client.evaluate(`(() => {
    const values = window.__ltds.cameraWorldPositions();
    if (values.length < 3) return false;
    const Vector3 = window.__ltds.camera().position.constructor;
    const target = new Vector3(values[0], values[1], values[2]);
    window.__ltds.controls().setView(target.clone().add(new Vector3(40, 30, 40)), target);
    return true;
  })()`);
}

function assertHonestReplacement(snapshot, label) {
  assert.equal(snapshot.root.refine, 'REPLACE', `${label}: root refinement was mutated`);
  if (snapshot.root.rendered) {
    assert.deepEqual(snapshot.renderedTiles.map((tile) => tile.uri), [snapshot.root.uri], `${label}: root and refined tiles rendered together`);
    assert.doesNotMatch(snapshot.lodStatus, /full-detail/, `${label}: rendered root was mislabeled full-detail`);
  } else {
    assert.ok(snapshot.renderedTiles.length > 0, `${label}: REPLACE transition left no rendered tile`);
  }
}

test('browser camera-centered focal owner reacquires A across A -> B -> A views', { timeout: 180_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for focal-owner browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const tileRoot = path.join(root, 'test', 'fixtures', 'ktx2-tiles');
    const fixture = await startFixture(tileRoot, {
      tilesetJson: focusOwnerTilesetFixture(),
      assetAliases: {
        'a/root.b3dm': 'root.b3dm',
        'a/leaf.b3dm': 'LOD-0/Mesh.b3dm',
        'b/root.b3dm': 'root.b3dm',
        'b/leaf.b3dm': 'LOD-0/Mesh.b3dm',
      },
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-focus-owner-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1200, height: 800, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1200, screenHeight: 800,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
    await waitFor(client, `window.__ltds?.tiles?.()?.root?.children?.length === 2`,
      'two-owner fixture hierarchy did not load');
    // Hierarchy JSON arrives before asynchronous child preprocessing. A camera
    // pose derived from authored bounds must wait for those bounds, not merely
    // the existence of the JSON child objects.
    await waitFor(client, `window.__ltds.tiles().root.children.every(tile =>
      Boolean(tile.engineData?.boundingVolume))`,
      'two-owner fixture bounding volumes did not initialize');
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    const views = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const Vector3 = window.__ltds.camera().position.constructor;
      tiles.group.updateWorldMatrix(true, false);
      return tiles.root.children.map(tile => {
        const volume = tile.engineData?.boundingVolume;
        const obb = volume?.obb || volume?.regionObb;
        let center = null;
        if (obb?.box && obb?.transform) center = obb.box.getCenter(new Vector3()).applyMatrix4(obb.transform);
        else if (volume?.sphere?.center) center = volume.sphere.center.clone();
        if (!center) return null;
        center.applyMatrix4(tiles.group.matrixWorld);
        return {
          lookAt: center.toArray(),
          position: center.clone().add(new Vector3(0, 2.5, 3.5)).toArray(),
        };
      });
    })()`);
    assert.equal(views.length, 2);
    assert.ok(views.every(Boolean), JSON.stringify(views));
    assert.ok(Math.hypot(...views[0].lookAt.map((value, index) => value - views[1].lookAt[index])) > 4,
      `fixture owners are not spatially distinct: ${JSON.stringify(views)}`);

    const observeView = async (index, label) => {
      await setView(client, views[index].position, views[index].lookAt);
      await waitFor(client, `(() => {
        const tiles=window.__ltds.tiles();
        const leaf=tiles.root?.children?.[${index}]?.children?.[0];
        if (!leaf?.engineData?.scene || !tiles.group.children.includes(leaf.engineData.scene)) return false;
        let rendered=false;
        leaf.engineData.scene.traverse(object=>{
          if (!object.isMesh || !object.material) return;
          for (const material of (Array.isArray(object.material)?object.material:[object.material])) {
            if (material.visible !== false) rendered=true;
          }
        });
        return rendered;
      })()`, `${label} did not attach its zero-error replacement leaf`, 60_000);
      await waitFor(client, `(() => {
        const owner=(${focusOwnerExpression()});
        return Boolean(owner?.locked && owner.overlap > 0 && owner.path?.[0] === ${index});
      })()`, `${label} did not acquire its camera-centered focal owner`, 30_000);
      const owner = await client.evaluate(focusOwnerExpression());
      const branch = await client.evaluate(`(() => {
        const tiles=window.__ltds.tiles();
        const owner=tiles.root.children[${index}],leaf=owner.children[0];
        const rendered=tile=>{
          if (!tile?.engineData?.scene || !tiles.group.children.includes(tile.engineData.scene)) return false;
          let visible=false;
          tile.engineData.scene.traverse(object=>{
            if (!object.isMesh || !object.material) return;
            for (const material of (Array.isArray(object.material)?object.material:[object.material])) {
              if (material.visible !== false) visible=true;
            }
          });
          return visible;
        };
        return { ownerRendered:rendered(owner), leafRendered:rendered(leaf) };
      })()`);
      assert.equal(branch.leafRendered, true, `${label} leaf is not rendered`);
      assert.equal(branch.ownerRendered, false, `${label} violated strict REPLACE rendering`);
      return owner;
    };

    const ownerA = await observeView(0, 'camera view A');
    const ownerB = await observeView(1, 'camera view B');
    assert.notEqual(ownerB.key, ownerA.key, 'camera view B retained A as focal owner');
    const returnedA = await observeView(0, 'returned camera view A');
    assert.equal(returnedA.key, ownerA.key, 'returning to A did not reacquire A');

    const failures = client.events.filter(event => event.method === 'Network.responseReceived'
      && event.params.response.status >= 400);
    const errors = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
      && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('browser LOD stream hides the coarse root after complete top-down foreground coverage', { timeout: 580_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real LOD browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, origin;
  try {
    ({ server, vite, origin } = await startFixture(
      path.resolve(tileRoot),
      foregroundAcceptanceFixture({ alternateBranches: true }),
    ));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
    await client.command('Page.navigate', { url: `${origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
    await waitFor(client, `location.search.includes('view=model') && document.querySelector('#tab-model')?.classList.contains('active')`, 'explicit model selection did not activate the verified LOD');
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root && window.__ltds.tiles().group.children.length)', 'no LOD tile attached');
    await waitFor(client, 'window.__ltds.state?.lodManifestReport?.valid === true', 'REPLACE manifest did not validate');
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); return !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running; })()`, 'balanced startup queues did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); return !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running; })()`, 'balanced startup queues did not remain settled');
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 24`,
      'default view did not reach requested maximum Detail 24 refinement', 20_000);
    const balancedStartup = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      phase: window.__ltds.lodDiagnostics().phase,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
      status: document.querySelector('#lod-status').textContent,
    })`);
    assert.equal(balancedStartup.slider, '24');
    assert.equal(balancedStartup.requested, 24);
    assert.equal(balancedStartup.active, 24);
    assert.equal(balancedStartup.phase, 'requested-detail');
    assert.equal(balancedStartup.bootstrapPhase, 'complete');
    assert.ok(Math.abs(balancedStartup.errorTarget - 2) < 0.01,
      JSON.stringify(balancedStartup));
    assert.ok(balancedStartup.errorTarget < balancedStartup.bootstrapCoverageTarget,
      `steady Detail 24 must refine beyond the temporary coarse bootstrap target: ${JSON.stringify(balancedStartup)}`);
    assert.match(balancedStartup.status, /^LOD: (?:Detail 24|full-detail) \(\d+ tiles?\)$/);
    assert.doesNotMatch(balancedStartup.status, /warming|streaming/i);
    const startupLod0Requests = client.events.filter((event) => event.method === 'Network.requestWillBeSent'
      && /\/LOD-0\/[^/?#]+\.b3dm(?:[?#]|$)/i.test(event.params.request.url));
    assert.ok(startupLod0Requests.length < 16, `balanced startup fanned out to the complete LOD-0 frontier: ${startupLod0Requests.length}`);

    const home = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const volume = tiles.root.engineData.boundingVolume;
      const obb = volume.obb || volume.regionObb;
      const V = window.__ltds.camera().position.constructor;
      const min = new V(Infinity, Infinity, Infinity);
      const max = new V(-Infinity, -Infinity, -Infinity);
      tiles.group.updateWorldMatrix(true, false);
      const include = (x, y, z, matrix = null) => {
        const point = new V(x, y, z);
        if (matrix) point.applyMatrix4(matrix);
        point.applyMatrix4(tiles.group.matrixWorld);
        min.min(point); max.max(point);
      };
      if (obb?.box && obb?.transform) {
        for (const x of [obb.box.min.x, obb.box.max.x])
          for (const y of [obb.box.min.y, obb.box.max.y])
            for (const z of [obb.box.min.z, obb.box.max.z]) include(x, y, z, obb.transform);
      } else if (volume.sphere) {
        const c = volume.sphere.center, r = volume.sphere.radius;
        for (const x of [c.x-r, c.x+r])
          for (const y of [c.y-r, c.y+r])
            for (const z of [c.z-r, c.z+r]) include(x, y, z);
      } else return null;
      const center = min.clone().add(max).multiplyScalar(0.5);
      const diameter = max.clone().sub(min).length();
      const distance = Math.max(20, diameter * 0.9);
      const expected = new V(center.x, center.y + distance * 0.55, center.z + distance * 0.75);
      const actual = window.__ltds.camera().position;
      return { expected: expected.toArray(), actual: actual.toArray(), error: expected.distanceTo(actual), center: center.toArray(), diameter };
    })()`);
    assert.ok(home && home.error < 1e-5, `initial LOD framing ignored rendered world bounds: ${JSON.stringify(home)}`);

    await setView(client, [500, 600, 700], [50, 60, 70]);
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);
    const reset = await client.evaluate(`(() => {
      const expected = ${JSON.stringify(home.expected)};
      const p = window.__ltds.camera().position;
      return Math.hypot(p.x-expected[0], p.y-expected[1], p.z-expected[2]);
    })()`);
    assert.ok(reset < 1e-5, `Reset View did not restore world-bounds home: ${reset}`);

    const requestEventIndex = client.events.length;
    const explicitHighDetail = await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        slider: slider.value,
        requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
        errorTarget: window.__ltds.tiles().errorTarget,
      };
    })()`);
    assert.deepEqual(explicitHighDetail, {
      slider: '24', requested: 24, active: 24, errorTarget: 2,
    });

    const topRadius = Math.max(25, home.diameter * 0.15);
    const topPolar = 0.04;
    await setView(client, [
      home.center[0] + Math.sin(topPolar) * topRadius,
      home.center[1] + Math.cos(topPolar) * topRadius,
      home.center[2],
    ], home.center);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      await waitFor(client, `(() => {
        const tiles = window.__ltds.tiles();
        let visibleFine = 0;
        const visit = (tile) => {
          (tile?.children || []).forEach(visit);
          if (!(tile?.children || []).length && Number(tile?.geometricError) === 0
            && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) visibleFine += 1;
        };
        visit(tiles?.root);
        return visibleFine > 0 && window.__ltds.state.lodRuntimeProfile?.activeDetail === 24
          && !tiles?.downloadQueue?.running && !tiles?.parseQueue?.running && !tiles?.processNodeQueue?.running;
      })()`, 'top-down foreground did not settle to visible fine leaves', 90_000);
    } catch (error) {
      const diagnostics = await client.evaluate(`(() => {
        const tiles=window.__ltds.tiles(); const rows=[];
        const visit=(tile,parent=null)=>{(tile?.children||[]).forEach(child=>visit(child,tile));rows.push({uri:tile?.content?.uri||tile?.content?.url||'',error:tile?.geometricError,used:tile?.traversal?.used,inFrustum:tile?.traversal?.inFrustum,active:tile?.traversal?.active,visible:tile?.traversal?.visible,attached:Boolean(tile?.engineData?.scene&&tiles.group.children.includes(tile.engineData.scene)),loadingState:tile?.internal?.loadingState,parent:parent?.content?.uri||parent?.content?.url||''});};visit(tiles.root);return {loadAncestors:tiles.loadAncestors,loadSiblings:tiles.loadSiblings,errorTarget:tiles.errorTarget,rootRefine:tiles.root?.refine,groupChildren:tiles.group.children.length,downloadRunning:tiles.downloadQueue?.running,parseRunning:tiles.parseQueue?.running,cacheBytes:tiles.lruCache?.bytesSize,cacheCount:tiles.lruCache?.itemSet?.size,rows};
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const topCoverage = await client.evaluate(foregroundCoverageExpression());
    assert.ok(topCoverage.fineSamples > 0, `top-down coverage probe did not intersect attached full-detail geometry: ${JSON.stringify(topCoverage)}`);
    assert.ok(topCoverage.fineScenes > 0, `top-down view exposed no full-detail scenes: ${JSON.stringify(topCoverage)}`);
    assert.equal(topCoverage.rootRendered, false, `settled top-down view still rendered the coarse root: ${JSON.stringify(topCoverage)}`);
    assert.equal(topCoverage.queueRunning, false);
    assert.ok(client.events.slice(requestEventIndex).some((event) => event.method === 'Network.requestWillBeSent'
      && /\/LOD-0\/[^/?#]+\.b3dm(?:[?#]|$)/i.test(event.params.request.url)), 'explicit Detail 24 requested no LOD-0 content');
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);

    const pole = await client.evaluate(`(() => {
      document.querySelector('#btn-top').click();
      const controls = window.__ltds.controls();
      const camera = window.__ltds.camera();
      const V = camera.position.constructor;
      const target = new V(0, 18, 0);
      const topPosition = camera.position.clone();
      const topRadius = topPosition.distanceTo(target);
      const initialPolar = Math.acos(Math.max(-1, Math.min(1, topPosition.clone().sub(target).normalize().y)));
      controls._applyOrbit(target, 0, 0.001);
      const firstOrbitDelta = camera.position.distanceTo(topPosition);
      let minimumPolar = Infinity;
      let minimumQuaternionDot = 1;
      let previous = camera.quaternion.clone();
      for (let i = 0; i < 80; i += 1) {
        controls._applyOrbit(target, i % 2 ? 0.012 : -0.012, -0.25);
        const offset = camera.position.clone().sub(target).normalize();
        const polar = Math.acos(Math.max(-1, Math.min(1, offset.y)));
        minimumPolar = Math.min(minimumPolar, polar);
        minimumQuaternionDot = Math.min(minimumQuaternionDot, Math.abs(previous.dot(camera.quaternion)));
        previous.copy(camera.quaternion);
      }
      return {
        minimumPolar,
        configuredMinimum: controls.minPolar,
        initialPolar,
        topRadius,
        firstOrbitDelta,
        minimumQuaternionDot,
        finite: [...camera.position.toArray(), ...camera.quaternion.toArray()].every(Number.isFinite),
      };
    })()`);
    assert.equal(pole.finite, true, `top-down orbit produced non-finite camera state: ${JSON.stringify(pole)}`);
    assert.ok(pole.initialPolar > pole.configuredMinimum, `Top View began on the polar clamp instead of inside it: ${JSON.stringify(pole)}`);
    assert.ok(pole.firstOrbitDelta < pole.topRadius * 0.002, `first top-down orbit made a clamp catch-up jump: ${JSON.stringify(pole)}`);
    assert.ok(pole.minimumPolar >= pole.configuredMinimum - 1e-8, `top-down orbit crossed the polar limit: ${JSON.stringify(pole)}`);
    assert.ok(pole.minimumQuaternionDot > 0.99, `top-down orbit orientation jumped or flipped: ${JSON.stringify(pole)}`);
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);
    await waitFor(client, `(() => {
      const tiles = window.__ltds.tiles();
      const root = tiles?.root;
      return root?.refine === 'REPLACE'
        && !tiles?.downloadQueue?.running && !tiles?.parseQueue?.running && !tiles?.processNodeQueue?.running
        && Boolean(tiles?.group?.children?.length);
    })()`, 'settled home view did not retain a valid REPLACE frontier', 210_000);

    const initial = await client.evaluate(snapshotExpression());
    assert.equal(initial.errorPanel, 'none');
    assertHonestReplacement(initial, 'settled home view');
    assert.ok(initial.attachedMaterials.length > 0);
    const visibleInitialMaterials = initial.attachedMaterials.filter((item) => item.visible);
    assert.ok(visibleInitialMaterials.length > 0);
    assert.ok(visibleInitialMaterials.every((item) => item.depthWrite === true && item.polygonOffset === false && item.renderOrder === 0));
    assert.ok(initial.root.materials.every((item) => item.depthWrite === true && item.polygonOffset === false && item.renderOrder === 0));
    assert.ok(initial.attachedMaterials.every((item) => item.hasMap && item.imageReady), 'attached full-detail B3DM textures were not decoded and bound');
    assert.equal(initial.profile.memoryProfile.policyKey, 'roomy');
    assert.deepEqual(initial.cache, { minBytesSize: 0.5 * GiB, maxBytesSize: 3.75 * GiB, minSize: 8, maxSize: 1024, unloadPercent: 0.20 });

    await client.evaluate(`document.querySelector('#layer-cameras').click()`);
    await waitFor(client, 'window.__ltdsCams === 3', 'camera positions did not load');
    await setViewAtFirstCamera(client);
    await waitFor(client, 'window.__ltdsCamDrawn > 0', 'camera-facing view did not expose a representative', 30_000);
    const visibleCameras = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => {
        if (object.isInstancedMesh && object.visible && object.parent?.parent?.visible) {
          const colors = object.instanceColor;
          const sampled = object.material?.color?.clone?.();
          if (sampled && colors) sampled.fromBufferAttribute(colors, 0);
          const color = sampled?.getHex?.() ?? null;
          meshes.push({ count: object.count, color });
        }
      });
      return { totalInstances: meshes.reduce((sum, item) => sum + item.count, 0), meshes, drawn: window.__ltdsCamDrawn, drawToSource: window.__ltdsCamDrawToSource };
    })()`);
    assert.ok(visibleCameras.drawn > 0 && visibleCameras.drawn <= 3, JSON.stringify(visibleCameras));
    assert.equal(visibleCameras.totalInstances, visibleCameras.drawn * 4, 'each selected camera renders body, face, amber cue, and orange image-up tab');
    assert.deepEqual(visibleCameras.meshes.map(item => item.count).sort((a, b) => a - b), [visibleCameras.drawn, visibleCameras.drawn, visibleCameras.drawn, visibleCameras.drawn]);
    assert.equal(visibleCameras.drawToSource.length, visibleCameras.drawn);
    assert.deepEqual(visibleCameras.meshes.map(item => item.color).sort((a, b) => a - b), [0xD8DEE6, 0xEE5007, 0xF8CB2E, 0xEE5007].sort((a, b) => a - b));
    const cameraClick = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => { if (object.isInstancedMesh && object.count === window.__ltdsCamDrawn && object.parent?.parent?.visible) meshes.push(object); });
      if (meshes.length !== 4) return null;
      const M = meshes[0].matrixWorld.constructor, V = window.__ltds.camera().position.constructor;
      const instance = new M();
      meshes[0].getMatrixAt(0, instance);
      meshes[0].updateWorldMatrix(true, false);
      const markerTarget = new V(0, 0, 0.24).applyMatrix4(instance).applyMatrix4(meshes[0].matrixWorld);
      window.__ltds.controls().setView(markerTarget.clone().add(new V(40, 30, 40)), markerTarget);
      window.__ltds.camera().updateMatrixWorld(true);
      const center = markerTarget.clone().project(window.__ltds.camera());
      const canvas = document.querySelector('#three-container canvas'), rect = canvas.getBoundingClientRect();
      const projected = { x: rect.left + (center.x + 1) * rect.width / 2, y: rect.top + (1 - center.y) * rect.height / 2 };
      const raycaster = new (window.__ltds.controls()._raycaster.constructor)();
      for (let radius = 0; radius <= 40; radius += 2) {
        for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) {
          if (radius && Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = projected.x + dx, y = projected.y + dy;
          raycaster.setFromCamera(window.__ltds.controls()._ndc({ clientX: x, clientY: y }), window.__ltds.camera());
          const hit = raycaster.intersectObjects(meshes, false)[0];
          if (hit?.instanceId === 0) return { x, y, projected, meshHits: meshes.length };
        }
      }
      return { projected, meshHits: meshes.length, missed: true };
    })()`);
    assert.ok(cameraClick && !cameraClick.missed && Number.isFinite(cameraClick.x) && Number.isFinite(cameraClick.y), `no raycastable camera marker pixel: ${JSON.stringify(cameraClick)}`);
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'camera marker did not open its docked photo preview');
    const photoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(photoUrl, new RegExp(`/camera-photos/photo-${visibleCameras.drawToSource[0]}\\.jpg$`));
    assert.doesNotMatch(photoUrl, /storage|mnt|dataset/i);
    await waitFor(client, `document.querySelector('#photo-img').naturalWidth === 1`, 'capability-scoped camera image did not decode');
    const dockedPhoto = await client.evaluate(`(() => {
      const modal=document.querySelector('#photo-modal'),frame=document.querySelector('#photo-frame'),wrap=document.querySelector('#photo-imgwrap');
      const fr=frame.getBoundingClientRect(),wr=wrap.getBoundingClientRect();
      return {presentation:modal.dataset.presentation,modalPointer:getComputedStyle(modal).pointerEvents,framePointer:getComputedStyle(frame).pointerEvents,right:innerWidth-fr.right,top:fr.top,aspect:wr.width/wr.height};
    })()`);
    assert.equal(dockedPhoto.presentation, 'docked');
    assert.equal(dockedPhoto.modalPointer, 'none', 'docked host must not intercept model navigation outside the photo');
    assert.equal(dockedPhoto.framePointer, 'auto');
    assert.ok(dockedPhoto.right >= 0 && dockedPhoto.right <= 20 && dockedPhoto.top > 50, JSON.stringify(dockedPhoto));
    assert.ok(Math.abs(dockedPhoto.aspect - 1) < 0.02, 'natural square photo aspect was not preserved');
    await client.evaluate(`document.querySelector('#photo-imgwrap').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'expanded'`, 'photo click did not open the expanded inspector');
    await assertExpandedPhotoWheelAndPan(client);
    await client.evaluate(`document.querySelector('#photo-close').click()`);
    await client.evaluate(`(() => { window.__ltds.state.activeMode='cloud'; window.__ltds.state.cloudMode='direct'; return true; })()`);
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'direct LAZ/PLY camera marker did not open its docked photo preview');
    const directPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.equal(directPhotoUrl, photoUrl, 'Model and direct Point Cloud markers did not use the same scoped photo URL');
    await client.evaluate(`(() => { document.querySelector('#photo-close').click(); window.__ltds.state.activeMode='model'; window.__ltds.state.cloudMode='none'; return true; })()`);
    await client.evaluate(`document.querySelector('#tab-ortho').click()`);
    await waitFor(client, `document.querySelector('#panel-camera-positions').style.display === 'block' && window.__ltdsMapCamDrawn > 0`, 'orthophoto did not expose bounded camera positions', 30_000);
    const mapCamera = await client.evaluate(`(() => ({drawn:window.__ltdsMapCamDrawn,sources:window.__ltdsMapCamDrawToSource.slice().sort((a,b)=>a-b),icons:document.querySelectorAll('.map-camera-canvas').length}))()`);
    assert.equal(mapCamera.drawn, 3, 'map must preserve every source photo marker');
    assert.equal(mapCamera.icons, 1, 'all map pins share one canvas');
    await assertStableMapCameraAnchors(client);
    await client.evaluate(`document.querySelector('.map-camera-selector').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); document.querySelector('.map-camera-selector').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'orthophoto camera did not open the shared photo preview');
    const mapPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(mapPhotoUrl, new RegExp(`/camera-photos/photo-${mapCamera.sources[0]}\\.jpg$`));
    await client.evaluate(`document.querySelector('#photo-close').click(); document.querySelector('#tab-model').click()`);
    await waitFor(client, `document.querySelector('#tab-model').classList.contains('active')`, 'model did not resume after orthophoto camera verification');
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);
    await client.evaluate(`document.querySelector('#layer-cameras').click()`);

    const transferred = await client.evaluate(`(() => {
      const state = window.__ltds.state;
      const V = window.__ltds.camera().position.constructor;
      const expectedPosition = new V(35, 75, 95);
      const expectedTarget = new V(5, 15, 25);
      const positionUtm = window.__ltds.worldToUtm(expectedPosition);
      const targetUtm = window.__ltds.worldToUtm(expectedTarget);
      const iframe = document.createElement('iframe');
      iframe.id = 'pc-iframe';
      iframe.src = 'about:blank';
      document.querySelector('#cloud-container').appendChild(iframe);
      state.cloudMode = 'potree';
      state.pcIframeLoaded = true;
      document.querySelector('#tab-cloud').click();
      iframe.contentWindow.viewer = { scene: { view: {
        position: { x: positionUtm.e, y: positionUtm.n, z: positionUtm.alt },
        getPivot: () => ({ x: targetUtm.e, y: targetUtm.n, z: targetUtm.alt }),
      } } };
      iframe.contentWindow.__pcViewReady = true;
      iframe.contentWindow.__getViewUTM = () => ({
        position: [positionUtm.e, positionUtm.n, positionUtm.alt],
        target: [targetUtm.e, targetUtm.n, targetUtm.alt],
      });
      document.querySelector('#tab-model').click();
      return {
        expected: expectedPosition.toArray(),
        beforeRootError: window.__ltds.camera().position.distanceTo(expectedPosition),
      };
    })()`);
    assert.ok(transferred.beforeRootError < 1e-5, `point-cloud view was not transferred before LOD startup: ${JSON.stringify(transferred)}`);
    try {
      await waitFor(client, 'Boolean(window.__ltds.tiles()?.root && window.__ltds.tiles().group.children.length)', 'reloaded LOD view did not attach a tile after point-cloud transfer', 15_000);
    } catch (error) {
      const transferDiagnostics = await client.evaluate(`(() => ({
        activeMode:window.__ltds.state?.activeMode,meshSource:window.__ltds.state?.meshSource,
        tabModel:document.querySelector('#tab-model')?.classList.contains('active'),
        error:getComputedStyle(document.querySelector('#error-panel')).display,
        errorText:document.querySelector('#error-panel')?.textContent,
        profile:window.__ltds.state?.lodRuntimeProfile,
        root:Boolean(window.__ltds.tiles()?.root),children:window.__ltds.tiles()?.group?.children?.length ?? null,
        queues:window.__ltds.tiles()?{download:window.__ltds.tiles().downloadQueue?.running,parse:window.__ltds.tiles().parseQueue?.running,process:window.__ltds.tiles().processNodeQueue?.running}:null,
      }))()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(transferDiagnostics)}`);
    }
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); const root=t?.root; return Boolean(root?.engineData?.scene && t.group.children.includes(root.engineData.scene) && document.querySelector('#loading-overlay')?.classList.contains('hidden')); })()`, 'reloaded LOD view exposed the canvas before its root fallback attached', 90_000);
    const transferAfterRoot = await client.evaluate(`(() => {
      const expected = ${JSON.stringify([35, 75, 95])};
      const p = window.__ltds.camera().position;
      return Math.hypot(p.x-expected[0], p.y-expected[1], p.z-expected[2]);
    })()`);
    assert.ok(transferAfterRoot < 1e-5, `LOD startup overwrote the transferred point-cloud view: ${transferAfterRoot}`);

    await setView(client, [0, 44, 52], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return n>0; })()`, 'close view did not refine');
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); return window.__ltds.state.lodRuntimeProfile?.activeDetail === 24 && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running; })()`, 'close view did not complete staged foreground coverage', 210_000);
    const close = await client.evaluate(snapshotExpression());
    assert.ok(close.visibleLeaves.length > 0);
    assert.equal(close.root.rendered, false, `close view retained its coarse root: ${JSON.stringify(close)}`);
    assertHonestReplacement(close, 'close view');

    const orbitPixels = await client.evaluate(`(() => {
      const controls=window.__ltds.controls(); const rect=controls.dom.getBoundingClientRect();
      const rows=[],positions=[[0.08,0.08],[0.92,0.08],[0.08,0.92],[0.92,0.92],[0.5,0.5],[0.35,0.5],[0.65,0.5],[0.5,0.35],[0.5,0.65],[0.2,0.2],[0.8,0.2],[0.2,0.8],[0.8,0.8]];
      for(const [fx,fy] of positions){
        const x=rect.left+rect.width*fx,y=rect.top+rect.height*fy;
        const ndc={x:((x-rect.left)/rect.width)*2-1,y:-((y-rect.top)/rect.height)*2+1};
        rows.push({x,y,hit:Boolean(controls.surfacePick(ndc))});
        if(rows.some(row=>row.hit)&&rows.some(row=>!row.hit))break;
      }
      return {rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},surface:rows.find(row=>row.hit)||null,empty:rows.find(row=>!row.hit)||null};
    })()`);
    assert.ok(orbitPixels.surface && orbitPixels.empty, `could not locate both model and background pixels: ${JSON.stringify(orbitPixels)}`);
    const cameraState = () => client.evaluate(`({position:window.__ltds.camera().position.toArray(),quaternion:window.__ltds.camera().quaternion.toArray()})`);
    const dragFrom = async (point) => {
      const centerX=orbitPixels.rect.left+orbitPixels.rect.width/2;
      const centerY=orbitPixels.rect.top+orbitPixels.rect.height/2;
      const endX=point.x+(point.x<centerX?32:-32),endY=point.y+(point.y<centerY?18:-18);
      await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
      await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:endX,y:endY,button:'left',buttons:1});
      await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:endX,y:endY,button:'left',buttons:0,clickCount:1});
    };
    const emptyBefore = await cameraState();
    await dragFrom(orbitPixels.empty);
    const emptyAfter = await cameraState();
    const cameraDelta = (before,after) => Math.max(...before.position.map((value,index)=>Math.abs(value-after.position[index])),1-Math.abs(before.quaternion.reduce((sum,value,index)=>sum+value*after.quaternion[index],0)));
    assert.ok(cameraDelta(emptyBefore,emptyAfter)<1e-8,`empty-background drag moved the camera: ${JSON.stringify({emptyBefore,emptyAfter,orbitPixels})}`);
    const surfaceBefore = await cameraState();
    await dragFrom(orbitPixels.surface);
    const surfaceAfter = await cameraState();
    assert.ok(cameraDelta(surfaceBefore,surfaceAfter)>1e-4,'valid model-surface drag did not orbit');
    await setView(client, [0, 44, 52], [0, 18, 0]);

    const defaultDetail = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      errorTarget: window.__ltds.tiles().errorTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
      downloadJobs: window.__ltds.tiles().downloadQueue.maxJobs,
      parseJobs: window.__ltds.tiles().parseQueue.maxJobs,
    })`);
    assert.equal(defaultDetail.slider, '24');
    assert.equal(defaultDetail.downloadJobs, 8);
    assert.equal(defaultDetail.parseJobs, 2);
    assert.ok(Math.abs(defaultDetail.errorTarget - 2 * Math.max(1, defaultDetail.errorScale / 2)) < 0.01,
      JSON.stringify(defaultDetail));
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    try {
      await waitFor(client, `(() => { const r=window.__ltds.tiles().root; const p=window.__ltds.state.lodRuntimeProfile; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return Math.abs(window.__ltds.tiles().errorTarget-512*Math.max(1,p.errorScale/2))<0.01&&n===0; })()`, 'minimum Detail setting did not coarsen the active frontier', 10_000);
    } catch (error) {
      const detailDiagnostics = await client.evaluate(`(() => {
        const tiles=window.__ltds.tiles(); const rows=[];
        const visit=(tile,parent=null)=>{(tile?.children||[]).forEach(child=>visit(child,tile));if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.traversal?.visible)rows.push({uri:tile.content?.uri||'',parentError:parent?.traversal?.error,parentInFrustum:parent?.traversal?.inFrustum,active:tile.traversal?.active,sceneVisible:tile.engineData?.scene?.visible});};
        visit(tiles.root); return {errorTarget:tiles.errorTarget,loadAncestors:tiles.loadAncestors,rootRefine:tiles.root?.refine,rows};
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(detailDiagnostics)}`);
    }
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; const p=window.__ltds.state.lodRuntimeProfile; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return Math.abs(window.__ltds.tiles().errorTarget-2*Math.max(1,p.errorScale/2))<0.01&&n>0; })()`, 'maximum Detail setting did not restore full-detail leaves');

    await setView(client, [0, 1300, 1300], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return n===0; })()`, 'far view kept LOD-0 leaves');
    const far = await client.evaluate(snapshotExpression());
    assert.equal(far.visibleLeaves.length, 0);
    assert.ok(far.attachedTiles.length > 0, JSON.stringify(far));
    assert.ok(far.renderedTiles.some((tile) => tile.error > 0),
      `far view rendered no positive-error coarse/fallback tile: ${JSON.stringify(far)}`);

    const closeSet = new Set(close.visibleLeaves);
    const candidates = await client.evaluate(`(() => {
      const tiles=window.__ltds.tiles();
      const Vector3=window.__ltds.camera().position.constructor;
      tiles.group.updateMatrixWorld(true);
      const close=new Set(${JSON.stringify([...closeSet])});
      const rows=[];
      const visit=(tile)=>{
        (tile?.children||[]).forEach(visit);
        const uri=tile.content?.uri||tile.content?.url||null;
        if ((tile?.children||[]).length || Number(tile?.geometricError)!==0 || close.has(uri)) return;
        const volume=tile.engineData?.boundingVolume;
        const obb=volume?.obb||volume?.regionObb;
        let center=null;
        if (obb?.box&&obb?.transform) center=obb.box.getCenter(new Vector3()).applyMatrix4(obb.transform);
        else if (volume?.sphere?.center) center=volume.sphere.center.clone();
        if (!center) return;
        center.applyMatrix4(tiles.group.matrixWorld);
        rows.push({uri,lookAt:[center.x,center.y,center.z],position:[center.x,center.y+30,center.z+55]});
      };
      visit(tiles.root);
      return rows;
    })()`);
    assert.ok(candidates.length > 0, 'tile hierarchy exposed no alternate full-detail view');

    let panned = null;
    const panSamples = [];
    for (const candidate of candidates) {
      await setView(client, candidate.position, candidate.lookAt);
      try {
        await waitFor(client, `(() => { const t=window.__ltds.tiles(); const close=new Set(${JSON.stringify([...closeSet])}); let found=false; const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url;if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&!close.has(uri))found=true;};f(t.root);return found; })()`, 'alternate detailed leaf did not attach', 30_000);
      } catch {}
      const sample = await client.evaluate(snapshotExpression());
      panSamples.push({ candidate, visibleLeaves: sample.visibleLeaves, camera: sample.camera });
      if (sample.visibleLeaves.some((uri) => !closeSet.has(uri))) {
        panned = sample;
        break;
      }
    }
    assert.ok(panned, `panning did not replace the detailed frontier: ${JSON.stringify({ close: [...closeSet], panSamples })}`);
    panned = await client.evaluate(snapshotExpression());
    assertHonestReplacement(panned, 'panned view');

    // Returning to the original close-up must restore its detailed REPLACE
    // frontier without retaining a coarse ancestor over or under it.
    await setView(client, [0, 44, 52], [0, 18, 0]);
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); const expected=new Set(${JSON.stringify([...closeSet])}); let found=false; const f=(tile)=>{(tile?.children||[]).forEach(f);const rendered=tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&(()=>{let visible=false;tile.engineData.scene.traverse(object=>{if(object.isMesh&&object.material)for(const material of(Array.isArray(object.material)?object.material:[object.material]))if(material.visible!==false)visible=true;});return visible;})();if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&rendered&&expected.has(tile.content?.uri||tile.content?.url))found=true;};f(t.root);return found; })()`, 'returning to the close view did not restore its detailed leaf', 120_000);
    const returned = await client.evaluate(snapshotExpression());
    assert.ok(returned.visibleLeaves.some((uri) => closeSet.has(uri)));
    assertHonestReplacement(returned, 'returned close view');

    const failures = client.events.filter((event) => event.method === 'Network.responseReceived' && event.params.response.status >= 400);
    // Middleware-mode Vite has no HMR WebSocket endpoint, and the sandboxed
    // browser cannot fetch the production site's decorative branding image.
    // Ignore only those exact harness-only URLs; every application or tile
    // error still fails this assertion.
    const isHarnessOnlyEvent = (event) => {
      const url = event.method === 'Log.entryAdded'
        ? event.params.entry.url
        : event.method === 'Runtime.exceptionThrown'
          ? event.params.exceptionDetails.url
          : null;
      return typeof url === 'string' && (
        url.includes('/@vite/client')
        || url === 'https://ledgetopdroneservices.com/images/DroneLogo01.webp'
      );
    };
    const errors = client.events.filter((event) => (
      event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    ) && !isHarnessOnlyEvent(event));
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('browser close view refines at the default Detail and small motion retains decoded tiles', { timeout: 300_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real LOD retention acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(
      path.resolve(tileRoot),
      foregroundAcceptanceFixture({ boundaryGrid: true }),
    );
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-lod-retention-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1440, screenHeight: 900,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.engineData?.scene)', 'coarse root did not load');

    await waitFor(client, `(() => {
      const profile=window.__ltds.state.lodRuntimeProfile;
      return profile?.activeDetail===24 && profile?.bootstrapPhase==='complete'
        && Math.abs(window.__ltds.tiles().errorTarget-2)<0.01;
    })()`, 'default Detail did not finish bounded prefetch and enter raw Detail 24 refinement', 180_000);
    const defaultState = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
    })`);
    assert.equal(defaultState.slider, '24');
    assert.equal(defaultState.requested, 24);
    assert.equal(defaultState.active, 24);
    assert.equal(defaultState.bootstrapPhase, 'complete');
    assert.ok(Math.abs(defaultState.errorTarget - 2) < 0.01,
      `the default view must leave coarse bootstrap and resume raw Detail 24: ${JSON.stringify(defaultState)}`);
    assert.ok(defaultState.errorTarget < defaultState.bootstrapCoverageTarget, JSON.stringify(defaultState));

    const basePosition = [0, 44, 52];
    const baseTarget = [0, 18, 0];
    await setView(client, basePosition, baseTarget);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); let attached=0;
      const visit=(tile)=>{(tile?.children||[]).forEach(visit);if(!(tile?.children||[]).length
        && Number(tile?.geometricError)===0 && tile.engineData?.scene
        && t.group.children.includes(tile.engineData.scene))attached++;};
      visit(t.root); return attached>0 && !t.downloadQueue?.running
        && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'default Detail did not refine the close view to any zero-error leaf', 180_000);

    const requestStart = client.events.length;
    const baseline = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const scenes={};
      const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
        if(!(tile?.children||[]).length && Number(tile?.geometricError)===0 && tile.engineData?.scene
          && t.group.children.includes(tile.engineData.scene)) scenes[uri]=tile.engineData.scene.uuid;};
      visit(t.root); window.__ltdsRetentionBaseline=scenes;
      return { scenes, cachedBytes:t.lruCache.cachedBytes, minBytesSize:t.lruCache.minBytesSize,
        maxBytesSize:t.lruCache.maxBytesSize, minSize:t.lruCache.minSize, maxSize:t.lruCache.maxSize };
    })()`);
    assert.ok(Object.keys(baseline.scenes).length > 0, JSON.stringify(baseline));

    let boundary = null;
    const motionSamples = [];
    for (const offset of [1, 2, 4, 8]) {
      await setView(client,
        [basePosition[0] + offset, basePosition[1], basePosition[2]],
        [baseTarget[0] + offset, baseTarget[1], baseTarget[2]],
      );
      await client.evaluate(`(() => {
        const V=window.__ltds.camera().position.constructor;
        window.__ltds.controls()._applyOrbit(new V(${baseTarget.join(',')}), 0.018, 0.006);
        return true;
      })()`);
      // Sample inside the documented two-second recent-frontier window. The
      // purpose of this motion gate is to prove a newly detached scene remains
      // decoded for an immediate return, not to wait until retention expires.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sample = await client.evaluate(`(() => {
        const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{};
        const rows=[]; const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
          if(Object.hasOwn(baseline,uri))rows.push({uri,used:tile?.traversal?.used===true,cacheUsed:t.lruCache.isUsed(tile),
            inFrustum:tile?.traversal?.inFrustum===true,scene:tile?.engineData?.scene?.uuid||null,
            attached:Boolean(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
        visit(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,phase:window.__ltds.lodDiagnostics().phase};
      })()`);
      motionSamples.push({ offset, sample });
      if (sample.rows.some((row) => row.scene && row.cacheUsed === true && row.attached === false)) {
        boundary = { offset, sample };
        break;
      }
    }
    assert.ok(boundary, `an 8-meter pan plus one-degree orbit did not detach a decoded baseline tile inside bounded recent-frontier retention: ${JSON.stringify(motionSamples)}`);
    assert.notEqual(boundary.sample.phase, 'memory-limited', JSON.stringify(boundary));

    await setView(client, basePosition, baseTarget);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{};
      let expected=0,attached=0; const visit=(tile)=>{(tile?.children||[]).forEach(visit);
        const uri=tile?.content?.uri||tile?.content?.url||''; if(!Object.hasOwn(baseline,uri))return;
        expected++; if(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))attached++;};
      visit(t.root); return expected===Object.keys(baseline).length && attached===expected
        && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'returned close view did not restore and settle its previous frontier', 180_000);
    const returned = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{}; const rows=[];
      const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
        if(Object.hasOwn(baseline,uri))rows.push({uri,before:baseline[uri],after:tile?.engineData?.scene?.uuid||null,
          attached:Boolean(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
      visit(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,phase:window.__ltds.lodDiagnostics().phase};
    })()`);
    const changedScenes = returned.rows.filter((row) => row.before !== row.after);
    const baselineUris = Object.keys(baseline.scenes);
    const repeatedRequests = client.events.slice(requestStart)
      .filter((event) => event.method === 'Network.requestWillBeSent'
        && baselineUris.some((uri) => new URL(event.params.request.url).pathname.endsWith(`/${uri}`)))
      .map((event) => new URL(event.params.request.url).pathname);
    assert.deepEqual(changedScenes, [], `small camera motion discarded just-viewed decoded tiles: ${JSON.stringify({ baseline, boundary, returned })}`);
    assert.deepEqual(repeatedRequests, [], `small camera motion re-requested just-viewed tiles: ${JSON.stringify(repeatedRequests)}`);
    assert.notEqual(returned.phase, 'memory-limited', JSON.stringify(returned));
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('browser camera layer preserves all in-view source markers and map anchors through motion', { timeout: 90_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real camera browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(path.resolve(tileRoot));
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-camera-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root && window.__ltds.tiles().group.children.length)', 'no LOD tile attached');
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete'`,
      'camera-layer fixture did not finish bounded LOD prefetch');
    const lodDiagnostics = await client.evaluate(`window.__ltds.lodDiagnostics()`);
    assert.ok(['overview', 'coverage', 'warmup', 'requested-detail', 'reduced-memory', 'memory-limited'].includes(lodDiagnostics.phase), JSON.stringify(lodDiagnostics));
    assert.ok(Number.isInteger(lodDiagnostics.pendingRequiredLeaves) && lodDiagnostics.pendingRequiredLeaves >= 0, JSON.stringify(lodDiagnostics));
    assert.ok([768, 1792, 3072, 3840].includes(lodDiagnostics.cache.maxMiB), JSON.stringify(lodDiagnostics));
    assert.doesNotMatch(JSON.stringify(lodDiagnostics), /https?:|token|secret|storage|mnt/i);
    await client.evaluate(`document.querySelector('#layer-cameras').click()`);
    try {
      await waitFor(client, 'window.__ltdsCams === 3', 'camera positions did not load', 20_000);
    } catch (error) {
      const diagnostics = await client.evaluate(`({ cams: window.__ltdsCams, drawn: window.__ltdsCamDrawn, loading: window.__ltds?.state?.camerasLoading, loaded: window.__ltds?.state?.camerasLoaded })`).catch(() => null);
      const browserErrors = client.events.filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'));
      assert.fail(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}; browserErrors=${JSON.stringify(browserErrors)}`);
    }
    await setViewAtFirstCamera(client);
    try {
      await waitFor(client, 'window.__ltdsCamDrawn > 0', 'camera-facing view did not expose a representative', 30_000);
    } catch (error) {
      const diagnostics = await client.evaluate(`(() => {
        const camera=window.__ltds.camera(); camera.updateMatrixWorld(true);
        const V=camera.position.constructor;
        const projected=[[0,20,0],[4,21,-3],[8,22,-6]].map(value=>{const p=new V(...value),view=p.clone().applyMatrix4(camera.matrixWorldInverse),ndc=p.clone().project(camera);return {value,view:view.toArray(),ndc:ndc.toArray()};});
        const meshes=[];window.__ltds.scene().traverse(object=>{if(object.isInstancedMesh)meshes.push({count:object.count,parentVisible:object.parent?.parent?.visible,group:object.parent?.parent?.name||''});});
        return {cams:window.__ltdsCams,drawn:window.__ltdsCamDrawn,drawToSource:window.__ltdsCamDrawToSource,camera:camera.position.toArray(),cameraWorldPositions:window.__ltds.cameraWorldPositions(),projected,meshes};
      })()`);
      assert.fail(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const state = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => {
        if (!object.isInstancedMesh || !object.parent?.parent?.visible) return;
        const c = new object.material.color.constructor();
        object.getColorAt(0, c);
        meshes.push({ count: object.count, color: c.getHex(), opacity: object.material.opacity, renderOrder: object.renderOrder, unlit: object.material.isMeshBasicMaterial === true });
      });
      return { source: window.__ltdsCams, drawn: window.__ltdsCamDrawn, meshes };
    })()`);
    assert.equal(state.source, 3);
    assert.ok(state.drawn >= 0 && state.drawn <= 3, JSON.stringify(state));
    assert.deepEqual(state.meshes.map((mesh) => mesh.count), [state.drawn, state.drawn, state.drawn, state.drawn]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.color), [0xD8DEE6, 0xEE5007, 0xF8CB2E, 0xEE5007]);
    assert.ok(state.meshes.every(mesh => mesh.unlit), 'model camera glyph colors must not vary with scene lighting');
    assert.deepEqual(state.meshes.map((mesh) => mesh.opacity), [0.82, 0.82, 0.82, 0.82]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.renderOrder), [0, 1, 2, 3]);

    const readScale = async (source = null) => client.evaluate(`(() => {
      const source = ${source === null ? 'window.__ltdsCamDrawToSource[0]' : Number(source)};
      const draw = window.__ltdsCamDrawToSource.indexOf(source);
      const mesh = (() => { let found = null; window.__ltds.scene().traverse((object) => {
        if (!found && object.isInstancedMesh && object.parent?.parent?.visible) found = object;
      }); return found; })();
      if (!mesh || draw < 0) return null;
      const matrix = new mesh.matrixWorld.constructor();
      const position = new mesh.position.constructor();
      const quaternion = new mesh.quaternion.constructor();
      const scale = new mesh.scale.constructor();
      mesh.getMatrixAt(draw, matrix);
      matrix.decompose(position, quaternion, scale);
      return { source, scale: scale.toArray() };
    })()`);
    const initialScale = await readScale();
    assert.ok(initialScale, 'initial representative scale was unavailable');
    assert.ok(initialScale.scale.every((value) => Math.abs(value - 0.5) < 1e-6), `default camera scale was not 0.5: ${JSON.stringify(initialScale)}`);
    const setCameraOffset = async (offset) => {
      await client.evaluate(`(() => {
        const values = window.__ltds.cameraWorldPositions();
        const Vector3 = window.__ltds.camera().position.constructor;
        const target = new Vector3(values[0], values[1], values[2]);
        window.__ltds.controls().setView(target.clone().add(new Vector3(${offset.join(',')})), target);
      })()`);
      await waitFor(client, `window.__ltdsCamDrawToSource.includes(${initialScale.source})`, 'source camera disappeared while zooming');
      return readScale(initialScale.source);
    };
    const closeScale = await setCameraOffset([4, 3, 4]);
    if (process.env.LTDS_CAMERA_SCREENSHOT_PREFIX) {
      const closeCapture = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${process.env.LTDS_CAMERA_SCREENSHOT_PREFIX}-close.png`, Buffer.from(closeCapture.data, 'base64'));
    }
    const farScale = await setCameraOffset([100, 75, 100]);
    assert.deepEqual(await client.evaluate('window.__ltdsCamDrawToSource'), [0, 1, 2], 'overlapping far cameras must all remain selectable');
    if (process.env.LTDS_CAMERA_SCREENSHOT_PREFIX) {
      const farCapture = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${process.env.LTDS_CAMERA_SCREENSHOT_PREFIX}-far.png`, Buffer.from(farCapture.data, 'base64'));
    }
    assert.deepEqual(closeScale.scale, initialScale.scale, 'close zoom changed camera world scale');
    assert.deepEqual(farScale.scale, initialScale.scale, 'far zoom changed camera world scale');
    await client.evaluate(`(() => {
      const values = window.__ltds.cameraWorldPositions();
      const Vector3 = window.__ltds.camera().position.constructor;
      const target = new Vector3(values[0], values[1], values[2]);
      window.__ltds.controls().setView(target.clone().add(new Vector3(1000, 750, 1000)), target);
    })()`);
    await waitFor(client, `window.__ltdsCamDrawn > 0`, 'extreme far view exposed no camera representative');
    const extremeClick = await client.evaluate(`(() => {
      const source = window.__ltdsCamDrawToSource[0];
      const values = window.__ltds.cameraWorldPositions();
      const Vector3 = window.__ltds.camera().position.constructor;
      const point = new Vector3(values[source * 3], values[source * 3 + 1], values[source * 3 + 2]).project(window.__ltds.camera());
      const rect = document.querySelector('#three-container canvas').getBoundingClientRect();
      const x = rect.left + (point.x + 1) * rect.width / 2 + 8;
      const y = rect.top + (1 - point.y) * rect.height / 2;
      let expectedSource = -1, nearestDistance = Infinity;
      for (const candidate of window.__ltdsCamDrawToSource) {
        const projected = new Vector3(values[candidate * 3], values[candidate * 3 + 1], values[candidate * 3 + 2]).project(window.__ltds.camera());
        const px = rect.left + (projected.x + 1) * rect.width / 2;
        const py = rect.top + (1 - projected.y) * rect.height / 2;
        const distance = Math.hypot(px - x, py - y);
        if (distance < nearestDistance) { nearestDistance = distance; expectedSource = candidate; }
      }
      return { source, expectedSource, nearestDistance, x, y };
    })()`);
    assert.ok(extremeClick.nearestDistance <= 12, JSON.stringify(extremeClick));
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: extremeClick.x, y: extremeClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: extremeClick.x, y: extremeClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'screen-space fallback did not pick a sub-pixel distant camera');
    const extremePhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(extremePhotoUrl, new RegExp(`/camera-photos/photo-${extremeClick.expectedSource}\\.jpg$`));
    await waitFor(client, `document.querySelector('#photo-img').naturalWidth === 1`, 'camera photo did not decode in the docked preview');
    const dockedPhoto = await client.evaluate(`(() => {
      const modal=document.querySelector('#photo-modal'),frame=document.querySelector('#photo-frame'),wrap=document.querySelector('#photo-imgwrap');
      const fr=frame.getBoundingClientRect(),wr=wrap.getBoundingClientRect();
      return {presentation:modal.dataset.presentation,modalPointer:getComputedStyle(modal).pointerEvents,framePointer:getComputedStyle(frame).pointerEvents,right:innerWidth-fr.right,top:fr.top,aspect:wr.width/wr.height};
    })()`);
    assert.equal(dockedPhoto.modalPointer, 'none', 'docked host must not intercept viewer navigation outside the photo');
    assert.equal(dockedPhoto.framePointer, 'auto');
    assert.ok(dockedPhoto.right >= 0 && dockedPhoto.right <= 20 && dockedPhoto.top > 50, JSON.stringify(dockedPhoto));
    assert.ok(Math.abs(dockedPhoto.aspect - 1) < 0.02, 'docked preview did not preserve the photo natural aspect ratio');
    await client.evaluate(`document.querySelector('#photo-imgwrap').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'expanded'`, 'photo click did not open the expanded inspector');
    await assertExpandedPhotoWheelAndPan(client);
    await client.evaluate(`document.querySelector('#photo-close').click(); document.querySelector('#tab-ortho').click()`);
    await waitFor(client, `document.querySelector('#panel-camera-positions').style.display === 'block' && window.__ltdsMapCamDrawn > 0`, 'orthophoto did not expose bounded camera positions', 30_000);
    const mapCamera = await client.evaluate(`(() => ({drawn:window.__ltdsMapCamDrawn,sources:window.__ltdsMapCamDrawToSource.slice().sort((a,b)=>a-b),icons:document.querySelectorAll('.map-camera-canvas').length}))()`);
    assert.equal(mapCamera.drawn, 3, 'map must preserve every source photo marker');
    assert.equal(mapCamera.icons, 1, 'all map pins share one canvas');
    await assertStableMapCameraAnchors(client);
    await client.evaluate(`document.querySelector('.map-camera-selector').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); document.querySelector('.map-camera-selector').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'orthophoto camera did not open the shared photo preview');
    const mapPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(mapPhotoUrl, new RegExp(`/camera-photos/photo-${mapCamera.sources[0]}\\.jpg$`));
    await client.evaluate(`document.querySelector('#photo-close').click(); document.querySelector('#tab-model').click()`);
    await waitFor(client, `document.querySelector('#tab-model').classList.contains('active')`, 'model did not resume after orthophoto camera verification');


  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('browser hides the coarse root when every visible branch meets the active Detail target', { timeout: 720_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real foreground coverage acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(
      path.resolve(tileRoot),
      foregroundAcceptanceFixture({ worldCenterY: 0 }),
    );
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-foreground-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.engineData?.scene)', 'coarse root did not load');
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete'`,
      '16-leaf fixture did not finish its initial bounded prefetch', 180_000);
    const cacheOverrideGiB = Number(process.env.LTDS_LOD_TEST_CACHE_GIB);
    if (Number.isFinite(cacheOverrideGiB) && cacheOverrideGiB > 0) {
      await client.evaluate(`window.__ltds.tiles().lruCache.maxBytesSize = ${cacheOverrideGiB} * 2 ** 30`);
    }
    const sustainedAllLeaves = true;
    assert.equal(await client.evaluate(`window.__ltds.tiles().root.refine`), 'REPLACE');
    await client.evaluate(`(() => { const slider=document.querySelector('#lod-detail');slider.value='2';slider.dispatchEvent(new Event('input',{bubbles:true}));return true; })()`);
    await waitFor(client, 'window.__ltds.state.lodRuntimeProfile?.activeDetail===2', 'Detail 2 did not reset the warmup stage');
    await setView(client, [4.964815557187116, 124.12038892967789, 0], [0, 0, 0]);
    const stagedRequest = await client.evaluate(`(() => {
      const slider=document.querySelector('#lod-detail');slider.value='24';slider.dispatchEvent(new Event('input',{bubbles:true}));
      return {requested:window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active:window.__ltds.state.lodRuntimeProfile?.activeDetail,errorTarget:window.__ltds.tiles().errorTarget,
        errorScale:window.__ltds.state.lodRuntimeProfile?.errorScale};
    })()`);
    assert.equal(stagedRequest.requested, 24);
    assert.equal(stagedRequest.active, 24);
    assert.ok(Math.abs(stagedRequest.errorTarget - 2 * Math.max(1, stagedRequest.errorScale / 2)) < 0.01,
      JSON.stringify(stagedRequest));
    try {
      await waitFor(client, `(() => {
        const t=window.__ltds.tiles(); let required=0,attached=0;
        const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile?.traversal?.used===true&&tile?.traversal?.inFrustum===true){required++;if(tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene))attached++;}};
        f(t.root);
        const idle=!t.downloadQueue?.running&&!t.parseQueue?.running&&!t.processNodeQueue?.running;
        const rootAttached=Boolean(t.root?.engineData?.scene&&t.group.children.includes(t.root.engineData.scene));
        return required===16&&attached===required&&!rootAttached&&idle&&window.__ltds.state.lodRuntimeProfile?.activeDetail===24;
      })()`, 'sustained 16-leaf REPLACE frontier did not converge cleanly', 300_000);
    } catch (error) {
      const convergenceDiagnostics = await client.evaluate(`(() => {
        const t=window.__ltds.tiles();const rows=[];const visit=(tile,parent=null)=>{(tile?.children||[]).forEach(child=>visit(child,tile));
          if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0)rows.push({uri:tile.content?.uri||'',error:tile.traversal?.error,
            used:tile.traversal?.used,inFrustum:tile.traversal?.inFrustum,visible:tile.traversal?.visible,active:tile.traversal?.active,
            attached:Boolean(tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)),loadingState:tile.internal?.loadingState,
            parentError:parent?.traversal?.error,parentVisible:parent?.traversal?.visible,parentActive:parent?.traversal?.active});};
        visit(t.root);return {profile:window.__ltds.state.lodRuntimeProfile,errorTarget:t.errorTarget,diagnostics:window.__ltds.lodDiagnostics(),rows,
          queues:{download:t.downloadQueue?.running,parse:t.parseQueue?.running,process:t.processNodeQueue?.running},
          cache:{bytes:t.lruCache.cachedBytes,maxBytes:t.lruCache.maxBytesSize,full:t.lruCache.isFull(),items:t.lruCache.itemSet?.size,maxItems:t.lruCache.maxSize}};
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(convergenceDiagnostics)}`);
    }

    const diagnostic = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const root = tiles.root;
      const attachedScenes = tiles.group.children;
      const target = Number(tiles.errorTarget);
      const isAttached = (tile) => Boolean(tile?.engineData?.scene && attachedScenes.includes(tile.engineData.scene));
      const targetCovered = [];
      const uncovered = [];
      const strictLeaves = [];
      const visitStrict = (tile, parent = null) => {
        for (const child of (tile?.children || [])) visitStrict(child, tile);
        if ((tile?.children || []).length || Number(tile?.geometricError) !== 0
          || tile?.traversal?.used !== true || tile?.traversal?.inFrustum !== true) return;
        strictLeaves.push({
          uri: tile.content?.uri || tile.content?.url || '', attached: isAttached(tile),
          sceneUuid: tile.engineData?.scene?.uuid || null,
          loadingState: tile.internal?.loadingState ?? null,
          parentError: parent?.traversal?.error ?? null,
          parentAttached: isAttached(parent),
        });
      };
      const visitCoverage = (tile, path = 'root') => {
        if (!tile || tile.traversal?.used !== true || tile.traversal?.inFrustum !== true) return;
        const attached = isAttached(tile);
        const error = Number(tile.traversal?.error);
        if (tile !== root && attached && Number.isFinite(error) && error <= target) {
          targetCovered.push({ path, uri: tile.content?.uri || tile.content?.url || '', error, geometricError: tile.geometricError });
          return;
        }
        const children = tile.children || [];
        if (children.length) {
          children.forEach((child, index) => visitCoverage(child, path + '.' + index));
        } else if (Number(tile.geometricError) === 0) {
          if (attached) targetCovered.push({ path, uri: tile.content?.uri || tile.content?.url || '', error: 0, geometricError: 0 });
          else uncovered.push({ path, uri: tile.content?.uri || tile.content?.url || '', loadingState: tile.internal?.loadingState ?? null });
        }
      };
      visitStrict(root);
      for (const child of (root.children || [])) visitCoverage(child);
      const rootMaterials = [];
      root.engineData.scene?.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
          rootMaterials.push({ visible: material.visible !== false, transparent: material.transparent, opacity: material.opacity,
            alphaTest: material.alphaTest, hasAlphaMap: Boolean(material.alphaMap), depthWrite: material.depthWrite });
        }
      });
      return {
        target, targetCovered, uncovered, strictLeaves,
        rootAttached: isAttached(root),
        rootRendered: isAttached(root) && rootMaterials.some((material) => material.visible),
        rootMaterials,
        cache: {
          isFull: tiles.lruCache.isFull(),
          cachedBytes: tiles.lruCache.cachedBytes,
          maxBytesSize: tiles.lruCache.maxBytesSize,
          itemCount: tiles.lruCache.itemSet?.size ?? null,
          maxSize: tiles.lruCache.maxSize,
          items: [...(tiles.lruCache.bytesMap?.entries?.() || [])].map(([tile, bytes]) => ({
            uri: tile?.content?.uri || tile?.content?.url || 'root', bytes,
            used: tiles.lruCache.isUsed?.(tile) ?? null,
            loaded: tile?.internal?.loadingState ?? null,
          })).sort((left, right) => right.bytes - left.bytes),
        },
        queues: {
          download: Boolean(tiles.downloadQueue?.running), parse: Boolean(tiles.parseQueue?.running),
          process: Boolean(tiles.processNodeQueue?.running),
        },
      };
    })()`);

    assert.ok(diagnostic.targetCovered.length > 0, JSON.stringify(diagnostic));
    assert.equal(diagnostic.cache.isFull, false, `foreground refinement was blocked by a full LRU cache: ${JSON.stringify(diagnostic)}`);
    assert.deepEqual(diagnostic.uncovered, [], `foreground branches remained unloaded and unqueued: ${JSON.stringify(diagnostic)}`);
    assert.equal(diagnostic.rootRendered, false, `coarse root remained rendered over target-satisfied foreground: ${JSON.stringify(diagnostic)}`);

    if (process.env.LTDS_LOD_SCREENSHOT_PATH) {
      const capture = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(process.env.LTDS_LOD_SCREENSHOT_PATH, Buffer.from(capture.data, 'base64'));
    }

    const closeScenes = Object.fromEntries(diagnostic.strictLeaves.map((leaf) => [leaf.uri, leaf.sceneUuid]));
    const closeUris = Object.keys(closeScenes).sort();
    const returnRequestIndex = client.events.length;
    await setView(client, [0, 1300, 1300], [0, 18, 0]);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); let attached=0;
      const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene))attached++;};
      f(t.root); return attached===0 && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'far view did not detach the close leaves', 180_000);
    const farRetention = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const expected=${JSON.stringify(closeScenes)}; const rows=[];
      const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url||'';
        if(Object.hasOwn(expected,uri))rows.push({uri,before:expected[uri],after:tile.engineData?.scene?.uuid||null,cacheUsed:t.lruCache.isUsed(tile),
          attached:Boolean(tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
      f(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,minBytesSize:t.lruCache.minBytesSize,maxBytesSize:t.lruCache.maxBytesSize};
    })()`);
    assert.deepEqual(farRetention.rows.filter((row) => row.before !== row.after), [], `far view discarded the recent decoded frontier below the hard cap: ${JSON.stringify(farRetention)}`);
    assert.ok(farRetention.rows.every((row) => row.attached === false), JSON.stringify(farRetention));
    assert.ok(farRetention.rows.every((row) => row.cacheUsed === true),
      `bounded recent-frontier retention did not protect the detached decoded cut: ${JSON.stringify(farRetention)}`);
    await setView(client, sustainedAllLeaves ? [4.964815557187116, 124.12038892967789, 0] : [0, 44, 52], sustainedAllLeaves ? [0, 0, 0] : [0, 18, 0]);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); const expected=new Set(${JSON.stringify(closeUris)});
      const attached=new Set();
      const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url;if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&expected.has(uri))attached.add(uri);};
      f(t.root); return attached.size===expected.size && window.__ltds.state.lodRuntimeProfile?.activeDetail===24 && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'returning to close view did not restore every foreground leaf', 240_000);
    const returned = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const expected=new Set(${JSON.stringify(closeUris)}); const attached=[];
      const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url;if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&expected.has(uri))attached.push(uri);};
      f(t.root); let rootRendered=Boolean(t.root.engineData.scene&&t.group.children.includes(t.root.engineData.scene));
      const scenes={};const collect=(tile)=>{(tile?.children||[]).forEach(collect);const uri=tile.content?.uri||tile.content?.url||'';if(expected.has(uri))scenes[uri]=tile.engineData?.scene?.uuid||null;};collect(t.root);
      return {attached:attached.sort(),scenes,rootRendered,cacheBytes:t.lruCache.cachedBytes};
    })()`);
    assert.deepEqual(returned.attached, closeUris);
    assert.deepEqual(returned.scenes, closeScenes, `returning to the close view re-decoded retained scenes: ${JSON.stringify(returned)}`);
    const duplicateCloseRequests = client.events.slice(returnRequestIndex)
      .filter((event) => event.method === 'Network.requestWillBeSent'
        && closeUris.some((uri) => new URL(event.params.request.url).pathname.endsWith(`/${uri}`)))
      .map((event) => new URL(event.params.request.url).pathname);
    assert.deepEqual(duplicateCloseRequests, [], `far/return re-requested retained close leaves: ${JSON.stringify(duplicateCloseRequests)}`);
    assert.equal(returned.rootRendered, false, `returned view retained coarse root: ${JSON.stringify(returned)}`);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('browser never requests the original GLB when verified streaming tiles are absent', { timeout: 60_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for streaming-only browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startStreamingOnlyFixture();
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-streaming-only-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, `document.querySelector('#layer-tiles')?.textContent === 'Streaming LOD unavailable'`, 'streaming-only state did not render');
    const state = await client.evaluate(`({
      layerDisabled: document.querySelector('#layer-tiles')?.disabled,
      fullMeshLayerPresent: Boolean(document.querySelector('#layer-glb')),
      status: document.querySelector('#mode-status')?.textContent,
      tilesRuntimePresent: Boolean(window.__ltds?.tiles?.()),
    })`);
    assert.deepEqual(state, {
      layerDisabled: true,
      fullMeshLayerPresent: false,
      status: 'Streaming LOD unavailable or processing',
      tilesRuntimePresent: false,
    });
    await client.evaluate(`document.querySelector('#layer-tiles').click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fixture.requests.filter((requestPath) => requestPath === fixture.glbPath).length, 0, 'initialization or layer UI fetched the original GLB');
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('an open authenticated workspace discovers completed LOD tiles without loading the original GLB', { timeout: 90_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for session LOD refresh acceptance.');
    return;
  }

  const { makeGlb, TRIANGLE_A, writeAuditableFixture } = await import('./helpers/lod-fixture.mjs');
  const tileRoot = mkdtempSync(path.join(tmpdir(), 'ltds-session-lod-fixture-'));
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  writeAuditableFixture(tileRoot, {
    leafBTexture: validPng,
  });
  writeFileSync(path.join(tileRoot, 'coarse.glb'), makeGlb([TRIANGLE_A], validPng));
  writeFileSync(path.join(tileRoot, 'mid-a.glb'), makeGlb([TRIANGLE_A], validPng));
  writeFileSync(path.join(tileRoot, 'mid-b.glb'), makeGlb([TRIANGLE_A], validPng));
  const sessionTilesetPath = path.join(tileRoot, 'tileset.json');
  const sessionTileset = JSON.parse(readFileSync(sessionTilesetPath, 'utf8'));
  sessionTileset.root.content = { uri: 'coarse.glb' };
  sessionTileset.root.children = sessionTileset.root.children.map((leaf, index) => ({
    geometricError: 4,
    boundingVolume: leaf.boundingVolume,
    content: { uri: `mid-${index === 0 ? 'a' : 'b'}.glb` },
    children: [leaf],
  }));
  writeFileSync(sessionTilesetPath, JSON.stringify(sessionTileset));
  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, fixture;
  try {
    fixture = await startSessionRefreshFixture(tileRoot, { fineTileDelayMs: 3_000, shellTileDelayMs: 5_000 });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-session-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Page.navigate', { url: `${fixture.origin}/session/active/refresh-session?lodDistanceDemand=0` });
    await waitFor(client, `document.querySelector('#layer-tiles')?.textContent === 'Streaming LOD unavailable'`, 'initial unavailable LOD state did not render');
    assert.equal(await client.evaluate(`document.querySelector('#loading-overlay')?.classList.contains('hidden')`), true, 'unavailable tiles left the workspace blocked by its initializing overlay');
    const refreshDeadline = Date.now() + 15_000;
    while (fixture.currentRequests() < 2 && Date.now() < refreshDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fixture.currentRequests() >= 2, 'open session never refreshed its live model configuration');
    await waitFor(client, `window.__ltds?.state?.meshSource === 'tiles' && document.querySelector('#layer-tiles')?.textContent === 'Streamed LOD Mesh'`, 'completed LOD derivative was not applied to the open session');
    const tilesetDeadline = Date.now() + 10_000;
    while (!fixture.requests.includes('/session-assets/session-token/lod-browser-fixture/derivatives/tileset.json') && Date.now() < tilesetDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fixture.requests.includes('/session-assets/session-token/lod-browser-fixture/derivatives/tileset.json'), 'refreshed session did not initialize the streaming tileset');
    assert.ok(fixture.currentRequests() >= 2);
    assert.equal(fixture.requests.filter((requestPath) => requestPath === fixture.glbPath).length, 0, 'session refresh fetched the original GLB');
    assert.equal(await client.evaluate(`document.querySelector('#layer-tiles')?.textContent`), 'Streamed LOD Mesh');
    await client.evaluate(`document.querySelector('#tab-model').click()`);
    await waitFor(client, `location.search.includes('view=model')`, 'refreshed session could not enter model view');
    const hierarchyDeadline = Date.now() + 10_000;
    while (!await client.evaluate(`Boolean(window.__ltds?.tiles()?.root)`) && Date.now() < hierarchyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const refreshedRuntime = await client.evaluate(`({
      activeMode: window.__ltds?.state?.activeMode,
      meshSource: window.__ltds?.state?.meshSource,
      tiles: Boolean(window.__ltds?.tiles()),
      root: Boolean(window.__ltds?.tiles()?.root),
      manifest: window.__ltds?.state?.lodManifestReport,
      modeStatus: document.querySelector('#mode-status')?.textContent,
      lodStatus: document.querySelector('#lod-status')?.textContent,
    })`);
    const browserErrors = client.events.filter((event) => event.method === 'Log.entryAdded'
      || event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled').slice(-10);
    assert.equal(refreshedRuntime.root, true, `refreshed session did not attach the LOD hierarchy: ${JSON.stringify({ refreshedRuntime, requests: fixture.requests, browserErrors })}`);
    const logicalShellBytes = 1329 * 1024 * 1024;
    await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const shell = tiles.root.children;
      const logicalBytesPerTile = ${logicalShellBytes} / shell.length;
      const originalGetBytesUsed = tiles.getBytesUsed;
      tiles.getBytesUsed = function (tile) {
        return shell.includes(tile)
          ? logicalBytesPerTile
          : originalGetBytesUsed.call(this, tile);
      };
      // Keep both per-tile accounting and the aggregate cache total coherent.
      // This makes the browser exercise the real hard/soft byte paths instead
      // of only spoofing Map.get while cachedBytes remains near zero.
      for (const tile of shell) {
        if (tiles.lruCache.has(tile) && tile.internal?.loadingState === 4) {
          tiles.lruCache.setMemoryUsage(tile, logicalBytesPerTile);
        }
      }
      window.__restoreLogicalShellBytes = () => {
        tiles.getBytesUsed = originalGetBytesUsed;
        for (const tile of shell) {
          if (tiles.lruCache.has(tile)) {
            tiles.lruCache.setMemoryUsage(tile, originalGetBytesUsed.call(tiles, tile));
          }
        }
      };
      return true;
    })()`);
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 24
      && window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete'`,
      'refreshed session did not reach requested maximum Detail 24 refinement', 20_000);
    const balancedStartup = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      phase: window.__ltds.lodDiagnostics().phase,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
      prefetch: window.__ltds.lodDiagnostics().prefetch,
    })`);
    assert.deepEqual({ ...balancedStartup, errorTarget: undefined, errorScale: undefined, bootstrapCoverageTarget: undefined, prefetch: undefined }, {
      slider: '24', requested: 24, active: 24, errorTarget: undefined,
      phase: 'requested-detail', bootstrapPhase: 'complete', errorScale: undefined,
      bootstrapCoverageTarget: undefined, prefetch: undefined,
    });
    assert.equal(balancedStartup.errorScale, 1);
    assert.equal(balancedStartup.prefetch.shellMiB, 1329,
      `runtime did not measure the production-sized logical shell: ${JSON.stringify(balancedStartup)}`);
    assert.equal(balancedStartup.prefetch.shellSoftLimitMiB, 512);
    assert.equal(balancedStartup.prefetch.shellLimitMiB, 1536);
    assert.equal(balancedStartup.prefetch.detailReserveMiB, 1664);
    assert.equal(balancedStartup.prefetch.overSoftBudget, true,
      'crossing the 1.25 GiB target must remain diagnostic while the safe shell promotes');
    assert.equal(balancedStartup.errorTarget, 2,
      `steady Detail 24 did not use raw SSE: ${JSON.stringify(balancedStartup)}`);
    assert.ok(balancedStartup.errorTarget < balancedStartup.bootstrapCoverageTarget, JSON.stringify(balancedStartup));
    const promotedShell = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      return {
        rootInFallback: tiles.lodFallbackTiles?.has(tiles.root) === true,
        rootVisible: tiles.root?.traversal?.visible === true,
        rootAttached: Boolean(tiles.root?.engineData?.scene && tiles.group.children.includes(tiles.root.engineData.scene)),
        fallbackUris: [...(tiles.lodFallbackTiles || [])].map(tile => tile.content?.uri || tile.content?.url || ''),
        status: document.querySelector('#lod-status')?.textContent || '',
      };
    })()`);
    assert.equal(promotedShell.rootInFallback, false,
      `whole-model root remained a permanent fallback after shell promotion: ${JSON.stringify(promotedShell)}`);
    assert.equal(promotedShell.rootVisible, false,
      `whole-model root reactivated while direct shell coverage was available: ${JSON.stringify(promotedShell)}`);
    assert.equal(promotedShell.rootAttached, false,
      `whole-model root remained attached after complete shell promotion: ${JSON.stringify(promotedShell)}`);
    assert.deepEqual(promotedShell.fallbackUris.sort(), ['mid-a.glb', 'mid-b.glb']);
    assert.doesNotMatch(promotedShell.status, /full-detail/,
      `pending deep replacement work was mislabeled full-detail: ${JSON.stringify(promotedShell)}`);
    const startupRefinementDeadline = Date.now() + 10_000;
    while (!fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-a.b3dm')
      || requestPath.endsWith('/leaf-b.glb')) && Date.now() < startupRefinementDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-a.b3dm')
      || requestPath.endsWith('/leaf-b.glb')), true,
    'balanced startup did not request close-responsive child refinement');
    const coarseRequestIndex = fixture.requests.findIndex(requestPath => requestPath.endsWith('/coarse.glb'));
    const firstFineRequestIndex = fixture.requests.findIndex(requestPath => requestPath.endsWith('/leaf-a.b3dm')
      || requestPath.endsWith('/leaf-b.glb'));
    assert.ok(coarseRequestIndex >= 0 && firstFineRequestIndex > coarseRequestIndex,
      `the complete coarse root was not requested before refinement: ${JSON.stringify(fixture.requests)}`);
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); const root=t.root;
      const rootAttached=Boolean(root?.engineData?.scene&&t.group.children.includes(root.engineData.scene));
      const childAttached=root?.children?.some(child=>child.engineData?.scene&&t.group.children.includes(child.engineData.scene));
      return rootAttached||childAttached; })()`,
    'default refinement left no attached REPLACE coverage', 10_000);

    const explicitHighDetail = await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
        errorTarget: window.__ltds.tiles().errorTarget,
      };
    })()`);
    assert.deepEqual(explicitHighDetail, { requested: 24, active: 24, errorTarget: 2 });
    const fallbackSampleDeadline = Date.now() + 1_000;
    let fallbackSamples = 0;
    while (Date.now() < fallbackSampleDeadline) {
      const transitionFallback = await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const root = tiles.root;
        const selectedChildren = root.children.filter((child) => child.traversal?.used === true && child.traversal?.inFrustum === true);
        const attachedSelectedChildren = selectedChildren.filter((child) => child.engineData?.scene && tiles.group.children.includes(child.engineData.scene));
        const childStates = selectedChildren.map((child) => ({ loadingState: child.internal?.loadingState,
          hasScene: Boolean(child.engineData?.scene), parentIsGroup: child.engineData?.scene?.parent === tiles.group,
          visible: child.traversal?.visible, active: child.traversal?.active }));
        return {
          activeDetail: window.__ltds.state.lodRuntimeProfile?.activeDetail,
          loadAncestors: tiles.loadAncestors,
          loadSiblings: tiles.loadSiblings,
          loadAncestorSiblings: tiles.loadAncestorSiblings,
          rootVisible: root.traversal?.visible,
          rootAttached: Boolean(root.engineData?.scene && tiles.group.children.includes(root.engineData.scene)),
          rootActive: root.traversal?.active,
          rootIsLeaf: root.traversal?.isLeaf,
          rootAllChildrenLoaded: root.traversal?.allChildrenLoaded,
          rootWasSetActive: root.traversal?.wasSetActive,
          rootLoadingState: root.internal?.loadingState,
          rootHasScene: Boolean(root.engineData?.scene),
          loadingVisible: !document.querySelector('#loading-overlay')?.classList.contains('hidden'),
          selectedChildren: selectedChildren.length,
          attachedSelectedChildren: attachedSelectedChildren.length,
          childStates,
        };
      })()`);
      assert.ok(transitionFallback.activeDetail >= 13 && transitionFallback.activeDetail <= 24, JSON.stringify(transitionFallback));
      assert.equal(transitionFallback.loadAncestors, false);
      assert.equal(transitionFallback.loadSiblings, false);
      assert.equal(transitionFallback.loadAncestorSiblings, false);
      const coarseCoverage = transitionFallback.rootVisible && transitionFallback.rootAttached;
      const fineCoverage = transitionFallback.selectedChildren > 0
        && transitionFallback.attachedSelectedChildren === transitionFallback.selectedChildren;
      assert.ok(coarseCoverage || fineCoverage,
        `REPLACE transition lost both coarse fallback and selected-child coverage: ${JSON.stringify(transitionFallback)}`);
      fallbackSamples += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fallbackSamples >= 10, `expected continuous fallback samples, received ${fallbackSamples}`);
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 24`, 'explicit high-detail request did not complete its staged warmup');
    await waitFor(client, `(() => {
      const tiles = window.__ltds.tiles();
      let descendantVisible = false;
      const visit = tile => { for (const child of (tile?.children || [])) {
        if (child.traversal?.visible === true) descendantVisible = true;
        visit(child);
      }};
      visit(tiles.root);
      return tiles.root?.traversal?.visible === false && descendantVisible;
    })()`, 'settled fine frontier did not replace the coarse fallback');
    const fineTileDeadline = Date.now() + 10_000;
    while (!fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-b.glb')) && Date.now() < fineTileDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-b.glb')), true,
      'explicit Detail 24 did not refine into the fine child tile');

    await waitFor(client, `(() => {
      const tiles = window.__ltds.tiles();
      const leaves = [];
      const visit = tile => { (tile?.children || []).forEach(visit);
        if (!(tile?.children || []).length && Number(tile?.geometricError) === 0) leaves.push(tile);
      };
      visit(tiles.root);
      return leaves.length === 2 && leaves.every(tile => tile.engineData?.scene
        && tiles.group.children.includes(tile.engineData.scene))
        && !tiles.downloadQueue?.running && !tiles.parseQueue?.running && !tiles.processNodeQueue?.running;
    })()`, 'synthetic multi-branch fixture did not reach its full leaf frontier', 20_000);
    await waitFor(client, `document.querySelector('#lod-status')?.textContent?.includes('full-detail')`,
      'settled zero-error frontier was never reported as full-detail', 5_000);

    const motionRequestIndex = client.events.length;
    const beforeMotion = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles(); const scenes = {};
      const visit = tile => { (tile?.children || []).forEach(visit);
        const uri = tile?.content?.uri || tile?.content?.url || '';
        if (!(tile?.children || []).length && Number(tile?.geometricError) === 0) {
          let mesh = null;
          tile.engineData?.scene?.traverse?.(object => { if (!mesh && object.isMesh) mesh = object; });
          const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
          scenes[uri] = {
            scene: tile.engineData?.scene?.uuid || null,
            geometry: mesh?.geometry?.uuid || null,
            material: material?.uuid || null,
            texture: material?.map?.uuid || null,
          };
        }
      };
      visit(tiles.root); return scenes;
    })()`);
    const canvas = await client.evaluate(`(() => { const r=document.querySelector('#three-container canvas').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const findOrbitPoint = () => client.evaluate(`(() => {
      const controls = window.__ltds.controls();
      const tiles = window.__ltds.tiles();
      const camera = window.__ltds.camera();
      const r = document.querySelector('#three-container canvas').getBoundingClientRect();
      tiles.group.updateWorldMatrix(true, true);
      camera.updateMatrixWorld(true);
      let mesh = null;
      tiles.group.traverse(object => { if (!mesh && object.isMesh && object.geometry?.attributes?.position?.count >= 3) mesh = object; });
      if (!mesh) return null;
      const Vector3 = camera.position.constructor;
      const position = mesh.geometry.attributes.position;
      const center = new Vector3();
      for (let index = 0; index < 3; index++) center.add(new Vector3().fromBufferAttribute(position, index));
      center.multiplyScalar(1 / 3);
      mesh.localToWorld(center);
      center.project(camera);
      const projected = {
        x: r.left + (center.x + 1) * r.width / 2,
        y: r.top + (1 - center.y) * r.height / 2,
      };
      if (controls.surfacePick(controls._ndcFromClient(projected.x, projected.y))) return projected;
      for (let radius = 2; radius <= 24; radius += 2) {
        for (const [dx, dy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
          const x = projected.x + dx;
          const y = projected.y + dy;
          if (controls.surfacePick(controls._ndcFromClient(x, y))) return { x, y };
        }
      }
      return null;
    })()`);
    let orbitPoint = await findOrbitPoint();
    assert.ok(orbitPoint, 'synthetic detail frontier did not expose a rendered surface for orbit testing');
    let observedActivity = false;
    const stableMotionSample = async (label) => {
      const motionDeadline = Date.now() + 500;
      while (Date.now() < motionDeadline) {
        const sample = await client.evaluate(`(() => {
          const tiles = window.__ltds.tiles(); let attachedLeaves=0; let positiveVisible=0;
          const visit = tile => { (tile?.children || []).forEach(visit);
            if (tile?.traversal?.visible === true && Number(tile?.geometricError) > 0) positiveVisible++;
            if (!(tile?.children || []).length && Number(tile?.geometricError) === 0
              && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) attachedLeaves++;
          };
          visit(tiles.root);
          return {
            rootVisible: tiles.root?.traversal?.visible === true,
            rootAttached: Boolean(tiles.root?.engineData?.scene && tiles.group.children.includes(tiles.root.engineData.scene)),
            rootInFallback: tiles.lodFallbackTiles?.has(tiles.root) === true,
            attachedLeaves,
            positiveVisible,
          };
        })()`);
        assert.deepEqual(sample, {
          rootVisible: false, rootAttached: false, rootInFallback: false, attachedLeaves: 2, positiveVisible: 0,
        }, `${label} degraded the settled frontier: ${JSON.stringify(sample)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const cameraMatrix = () => client.evaluate(`(() => {
      const camera = window.__ltds.camera(); camera.updateMatrixWorld(true); return Array.from(camera.matrixWorld.elements);
    })()`);
    const assertCameraMoved = async (before, label) => {
      const after = await cameraMatrix();
      assert.notDeepEqual(after, before, `${label} did not change the camera matrix`);
    };
    for (const pixels of [1, 2, 4, 8]) {
      const beforeActivity = await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime`);
      const beforeMatrix = await cameraMatrix();
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'right', buttons: 2, clickCount: 1,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 2,
      });
      observedActivity ||= await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime > ${beforeActivity}`);
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 0, clickCount: 1,
      });
      await stableMotionSample(`a ${pixels}-pixel pan gesture`);
      await assertCameraMoved(beforeMatrix, `a ${pixels}-pixel pan gesture`);
    }
    orbitPoint = await findOrbitPoint();
    assert.ok(orbitPoint, 'panned detail frontier did not expose a rendered surface for orbit testing');
    for (const pixels of [1, 2, 4, 8]) {
      orbitPoint = await findOrbitPoint();
      assert.ok(orbitPoint, `settled detail frontier did not expose a rendered surface before a ${pixels}-pixel orbit gesture`);
      const beforeActivity = await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime`);
      const beforeMatrix = await cameraMatrix();
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: orbitPoint.x, y: orbitPoint.y, button: 'left', buttons: 1, clickCount: 1,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: orbitPoint.x + pixels, y: orbitPoint.y, button: 'left', buttons: 1,
      });
      observedActivity ||= await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime > ${beforeActivity}`);
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: orbitPoint.x + pixels, y: orbitPoint.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await stableMotionSample(`a ${pixels}-pixel orbit gesture`);
      await assertCameraMoved(beforeMatrix, `a ${pixels}-pixel orbit gesture`);
    }
    for (const delta of [1, 2, 4, 8]) {
      const beforeActivity = await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime`);
      const beforeMatrix = await cameraMatrix();
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: canvas.x, y: canvas.y, button: 'none', buttons: 0, deltaX: 0, deltaY: delta,
      });
      observedActivity ||= await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime > ${beforeActivity}`);
      await stableMotionSample(`a ${delta}-unit wheel-zoom gesture`);
      await assertCameraMoved(beforeMatrix, `a ${delta}-unit wheel-zoom gesture`);
    }
    assert.equal(observedActivity, true, 'CDP pan, orbit, and zoom gestures did not reach EarthLikeControls interaction state');
    const afterMotion = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles(); const scenes = {};
      const visit = tile => { (tile?.children || []).forEach(visit);
        const uri = tile?.content?.uri || tile?.content?.url || '';
        if (!(tile?.children || []).length && Number(tile?.geometricError) === 0) {
          let mesh = null;
          tile.engineData?.scene?.traverse?.(object => { if (!mesh && object.isMesh) mesh = object; });
          const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
          scenes[uri] = {
            scene: tile.engineData?.scene?.uuid || null,
            geometry: mesh?.geometry?.uuid || null,
            material: material?.uuid || null,
            texture: material?.map?.uuid || null,
          };
        }
      };
      visit(tiles.root); return scenes;
    })()`);
    assert.deepEqual(afterMotion, beforeMotion, 'tiny camera motion discarded already-decoded leaf scenes');
    const duplicateMotionRequests = client.events.slice(motionRequestIndex)
      .filter(event => event.method === 'Network.requestWillBeSent'
        && /\/leaf-(?:a\.b3dm|b\.glb)$/i.test(new URL(event.params.request.url).pathname))
      .map(event => new URL(event.params.request.url).pathname);
    assert.deepEqual(duplicateMotionRequests, [],
      `tiny camera motion re-requested cached leaf content: ${JSON.stringify(duplicateMotionRequests)}`);
    await client.evaluate(`window.__restoreLogicalShellBytes?.()`);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    rmSync(tileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('production-weighted broad view completes focal Detail 20 without cache-admission deadlock', { timeout: 180_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for production-weighted LOD acceptance.');
    return;
  }

  const { makeGlb, TRIANGLE_A } = await import('./helpers/lod-fixture.mjs');
  const tileRoot = mkdtempSync(path.join(tmpdir(), 'ltds-weighted-lod-fixture-'));
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const tileBytes = makeGlb([TRIANGLE_A], validPng);
  const shellCount = 11;
  const centerShellIndex = Math.floor(shellCount / 2);
  let fineIndex = 0;
  const shell = Array.from({ length: shellCount }, (_, shellIndex) => {
    const x = (shellIndex - centerShellIndex) * 28;
    const leafCount = shellIndex === centerShellIndex ? 15 : 14;
    const children = Array.from({ length: leafCount }, (_, localIndex) => {
      const uri = `fine-${String(fineIndex++).padStart(3, '0')}.glb`;
      writeFileSync(path.join(tileRoot, uri), tileBytes);
      return {
        geometricError: 0,
        boundingVolume: {
          sphere: [
            x + ((localIndex % 5) - 2) * 4,
            (Math.floor(localIndex / 5) - 1) * 4,
            0,
            5,
          ],
        },
        content: { uri },
      };
    });
    const uri = `shell-${String(shellIndex).padStart(2, '0')}.glb`;
    writeFileSync(path.join(tileRoot, uri), tileBytes);
    return {
      geometricError: 6,
      boundingVolume: { sphere: [x, 0, 0, 20] },
      content: { uri },
      children,
    };
  });
  assert.equal(fineIndex, 155);
  writeFileSync(path.join(tileRoot, 'coarse.glb'), tileBytes);
  writeFileSync(path.join(tileRoot, 'tileset.json'), JSON.stringify({
    asset: { version: '1.0' },
    geometricError: 64,
    root: {
      refine: 'REPLACE',
      geometricError: 64,
      boundingVolume: { sphere: [0, 0, 0, 170] },
      content: { uri: 'coarse.glb' },
      children: shell,
    },
  }));

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, fixture;
  try {
    fixture = await startFixture(tileRoot, {
      // This acceptance case validates the patched renderer package itself.
      // Force Vite to rebuild its optimized dependency so a prior browser run
      // cannot silently exercise an older renderer implementation.
      forceOptimizeDeps: true,
      assetDelayMs: relative => /^shell-\d+\.glb$/i.test(relative)
        ? 4_000
        : /^fine-\d+\.glb$/i.test(relative) ? 80 : 0,
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-weighted-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1440, screenHeight: 900,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
    await waitFor(client, `Boolean(window.__ltds?.tiles()?.root?.children?.length === ${shellCount})`,
      'production-weighted hierarchy did not initialize', 20_000);

    const logicalShellBytes = 1329 * 1024 * 1024;
    const logicalFineBytes = 24 * 1024 * 1024;
    await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const originalGetBytesUsed = tiles.getBytesUsed;
      const originalSetMemoryUsage = tiles.lruCache.setMemoryUsage;
      const shellBytes = ${logicalShellBytes} / ${shellCount};
      const fineBytes = ${logicalFineBytes};
      const decodedOnce = new WeakSet();
      const uriFor = tile => String(tile?.content?.uri || tile?.content?.url || '').split(/[?#]/, 1)[0];
      // Production byte plugins report decoded GPU/geometry allocations only
      // after a scene exists. Reserving the logical amount while the request is
      // merely queued would bypass the renderer's post-parse prospective check.
      const logicalBytes = tile => {
        if (tile?.engineData?.scene) decodedOnce.add(tile);
        if (!decodedOnce.has(tile)) return null;
        return /(?:^|\\/)shell-\\d+\\.glb$/i.test(uriFor(tile))
          ? shellBytes
          : /(?:^|\\/)fine-\\d+\\.glb$/i.test(uriFor(tile)) ? fineBytes : null;
      };
      tiles.getBytesUsed = function (tile) {
        const weighted = logicalBytes(tile);
        return weighted === null ? originalGetBytesUsed.call(this, tile) : weighted;
      };
      window.__weightedAdmissionTrace = [];
      tiles.lruCache.setMemoryUsage = function (tile, bytes) {
        const before = this.cachedBytes;
        const result = originalSetMemoryUsage.call(this, tile, bytes);
        window.__weightedAdmissionTrace.push({
          kind: 'set', uri: uriFor(tile), before, bytes, after: this.cachedBytes, max: this.maxBytesSize,
          loaded: tile?.internal?.loadingState, scene: Boolean(tile?.engineData?.scene),
        });
        if (window.__weightedAdmissionTrace.length > 40) window.__weightedAdmissionTrace.shift();
        return result;
      };
      tiles.addEventListener('tile-memory-pressure', event => {
        window.__weightedAdmissionTrace.push({
          kind: 'pressure', uri: uriFor(event.tile), before: tiles.lruCache.cachedBytes,
          bytes: event.bytesUsed, max: tiles.lruCache.maxBytesSize,
        });
        if (window.__weightedAdmissionTrace.length > 40) window.__weightedAdmissionTrace.shift();
      });
      for (const tile of tiles.lruCache.itemSet.keys()) {
        const weighted = logicalBytes(tile);
        if (weighted !== null && tile.internal?.loadingState === 4) {
          tiles.lruCache.setMemoryUsage(tile, weighted);
        }
      }
      window.__restoreProductionWeights = () => {
        tiles.getBytesUsed = originalGetBytesUsed;
        tiles.lruCache.setMemoryUsage = originalSetMemoryUsage;
        for (const tile of tiles.lruCache.itemSet.keys()) {
          tiles.lruCache.setMemoryUsage(tile, originalGetBytesUsed.call(tiles, tile));
        }
      };
      return true;
    })()`);

    const fineRequest = requestPath => /\/fine-\d+\.glb$/i.test(requestPath);
    const bootstrapDeadline = Date.now() + 20_000;
    let bootstrapPhase = null;
    while (Date.now() < bootstrapDeadline) {
      bootstrapPhase = await client.evaluate(`window.__ltds.state.lodRuntimeProfile?.bootstrapPhase`);
      if (bootstrapPhase === 'complete') break;
      assert.equal(fixture.requests.some(fineRequest), false,
        `prefetch descended into fine tiles while phase=${bootstrapPhase}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(bootstrapPhase, 'complete', 'production-weighted direct shell did not promote');

    // This developer acceptance scenario deliberately measures the Detail 20
    // workload after bootstrap, not the client's maximum-detail startup choice.
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '20';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail===20`, 'developer Detail 20 did not apply after bootstrap');

    const startup = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const diagnostics = window.__ltds.lodDiagnostics();
      return {
        requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
        policyKey: window.__ltds.state.lodRuntimeProfile?.memoryProfile?.policyKey,
        rawTarget: diagnostics.rawErrorTarget,
        target: tiles.errorTarget,
        softMiB: diagnostics.cache.softMiB,
        hardMiB: diagnostics.cache.maxMiB,
        shellMiB: diagnostics.prefetch.shellMiB,
        fallbackUris: [...(tiles.lodFallbackTiles || [])].map(tile => tile.content?.uri || tile.content?.url || ''),
        rootAttached: Boolean(tiles.root?.engineData?.scene && tiles.group.children.includes(tiles.root.engineData.scene)),
        rootVisible: tiles.root?.traversal?.visible === true,
      };
    })()`);
    assert.deepEqual({
      requested: startup.requested,
      active: startup.active,
      policyKey: startup.policyKey,
      rawTarget: startup.rawTarget,
      target: startup.target,
      softMiB: startup.softMiB,
      hardMiB: startup.hardMiB,
      shellMiB: startup.shellMiB,
      rootAttached: startup.rootAttached,
      rootVisible: startup.rootVisible,
    }, {
      requested: 20,
      active: 20,
      policyKey: 'roomy',
      rawTarget: 5.481,
      target: 5.481,
      softMiB: 3072,
      hardMiB: 3840,
      shellMiB: 1329,
      rootAttached: false,
      rootVisible: false,
    });
    assert.equal(startup.fallbackUris.length, shellCount);
    assert.deepEqual(startup.fallbackUris.sort(), Array.from({ length: shellCount }, (_, index) => `shell-${String(index).padStart(2, '0')}.glb`));

    const ownerDeadline = Date.now() + 15_000;
    let focalOwner = null;
    let lastFocalOwner = null;
    while (Date.now() < ownerDeadline && !focalOwner) {
      const candidate = await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const owner = tiles.root.children.find(tile => tile.__ltdsFocalOwnerLocked === true);
        if (!owner) return null;
        return {
          uri: owner.content?.uri || owner.content?.url || '',
          overlap: owner.__ltdsFocusOverlap,
          maximumOverlap: Math.max(...tiles.root.children.map(tile => Number(tile.__ltdsFocusOverlap) || 0)),
          effectiveTarget: owner.__ltdsPeripheralErrorTarget,
          blockers: Number(owner.__ltdsOwnerPendingBlockers) || 0,
          childTargets: owner.children.map(tile => tile.__ltdsPeripheralErrorTarget),
        };
      })()`);
      lastFocalOwner = candidate || lastFocalOwner;
      focalOwner = candidate?.effectiveTarget === 5.481
        && candidate.blockers >= 1
        && candidate.childTargets.filter(Number.isFinite).every(value => value === 5.481)
        ? candidate
        : null;
      if (!focalOwner) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(focalOwner,
      `no focal REPLACE owner reached raw Detail 20 while its cut was cold: ${JSON.stringify(lastFocalOwner)}`);
    assert.equal(focalOwner.uri, `shell-${String(centerShellIndex).padStart(2, '0')}.glb`, JSON.stringify(focalOwner));
    assert.equal(focalOwner.overlap, focalOwner.maximumOverlap,
      `the locked owner was not the most camera-centered fallback: ${JSON.stringify(focalOwner)}`);
    assert.equal(focalOwner.effectiveTarget, 5.481, JSON.stringify(focalOwner));
    assert.ok(focalOwner.blockers >= 1, JSON.stringify(focalOwner));
    assert.equal(focalOwner.childTargets.filter(Number.isFinite).every(value => value === 5.481), true,
      `locked focal descendants did not retain raw Detail 20: ${JSON.stringify(focalOwner)}`);

    const focalCompletionDeadline = Date.now() + 15_000;
    let focalCut = null;
    while (Date.now() < focalCompletionDeadline) {
      focalCut = await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const owner = tiles.root.children.find(tile => /shell-${String(centerShellIndex).padStart(2, '0')}\\.glb$/i.test(tile.content?.uri || tile.content?.url || ''));
        const attached = tile => Boolean(tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene));
        return {
          ownerAttached: attached(owner),
          ownerVisible: owner?.traversal?.visible === true,
          children: owner?.children?.length || 0,
          attachedChildren: owner?.children?.filter(attached).length || 0,
          cachedChildren: owner?.children?.filter(tile => tiles.lruCache.has(tile)).length || 0,
        };
      })()`);
      if (focalCut.children === focalCut.attachedChildren && !focalCut.ownerAttached) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(focalCut, {
      ownerAttached: false,
      ownerVisible: false,
      children: 15,
      attachedChildren: 15,
      cachedChildren: 15,
    }, `centered owner never completed its strict REPLACE cut: ${JSON.stringify(focalCut)}`);

    const sampleRuntime = () => client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const diagnostics = window.__ltds.lodDiagnostics();
      const attached = tile => Boolean(tile?.engineData?.scene && tiles.group.children.includes(tile.engineData.scene));
      const descendantsAttached = tile => {
        const result = [];
        const stack = [...(tile.children || [])];
        while (stack.length) {
          const next = stack.pop();
          if (attached(next)) result.push(next.content?.uri || next.content?.url || '');
          stack.push(...(next.children || []));
        }
        return result;
      };
      const replacementViolations = [];
      const coverageGaps = [];
      for (const owner of tiles.root.children) {
        const ownerUri = owner.content?.uri || owner.content?.url || '';
        const childAttached = descendantsAttached(owner);
        if (attached(owner) && childAttached.length) replacementViolations.push({ owner: ownerUri, children: childAttached });
        if (owner.traversal?.used === true && owner.traversal?.inFrustum === true && !attached(owner)) {
          const selected = owner.children.filter(tile => tile.traversal?.used === true && tile.traversal?.inFrustum === true);
          if (!selected.length || selected.some(tile => !attached(tile))) {
            coverageGaps.push({ owner: ownerUri, selected: selected.length, attached: selected.filter(attached).length });
          }
        }
      }
      const leaves = tiles.root.children.flatMap(owner => owner.children);
      const center = tiles.root.children[${centerShellIndex}];
      const centerRows = center.children.map(tile => ({
        uri: tile.content?.uri || tile.content?.url || '',
        attached: attached(tile),
        cached: tiles.lruCache.has(tile),
        scene: tile.engineData?.scene?.uuid || null,
      }));
      const cacheRows = [tiles.root, ...tiles.root.children, ...leaves]
        .filter(tile => tiles.lruCache.has(tile))
        .map(tile => ({
          uri: tile.content?.uri || tile.content?.url || 'root',
          bytes: tiles.lruCache.getMemoryUsage(tile),
          used: tiles.lruCache.isUsed(tile),
          attached: attached(tile),
          selected: tile.traversal?.used === true && tile.traversal?.inFrustum === true,
          errorTarget: tile.__ltdsPeripheralErrorTarget,
        }));
      const sum = (rows, predicate) => rows
        .filter(predicate)
        .reduce((total, row) => total + row.bytes, 0) / ${GiB};
      return {
        diagnostics,
        replacementViolations,
        coverageGaps,
        attachedFine: leaves.filter(attached).length,
        cachedFine: leaves.filter(tile => tiles.lruCache.has(tile)).length,
        cachedFineUris: leaves
          // LRU also contains queued/loading reservations. Only completed
          // scenes are warm cache: cancelled peripheral work may retry before
          // it has ever become decoded content. Keep the no-refetch contract
          // for every actually decoded baseline tile, not only the focal owner.
          .filter(tile => tiles.lruCache.has(tile)
            && tile.internal?.loadingState === 4 && Boolean(tile.engineData?.scene))
          .map(tile => tile.content?.uri || tile.content?.url || ''),
        cachedFineStates: leaves.filter(tile => tiles.lruCache.has(tile)).map(tile => ({
          uri: tile.content?.uri || tile.content?.url || '',
          loading: tile.internal?.loadingState,
          scene: Boolean(tile.engineData?.scene),
          attached: attached(tile),
        })),
        selectedFine: leaves.filter(tile => tile.traversal?.used === true && tile.traversal?.inFrustum === true).length,
        centerRows,
        ownerRows: tiles.root.children.map(owner => ({
          uri: owner.content?.uri || owner.content?.url || '',
          overlap: owner.__ltdsFocusOverlap,
          locked: owner.__ltdsFocalOwnerLocked === true,
          conservative: owner.__ltdsConservativeRawSse === true,
          childOverlaps: owner.children.map(tile => Number(tile.__ltdsFocusOverlap) || 0),
        })),
        peripheralTargets: tiles.root.children.map(tile => tile.__ltdsPeripheralErrorTarget).filter(Number.isFinite),
        admissionTrace: [...(window.__weightedAdmissionTrace || [])],
        cacheBreakdown: {
          rows: cacheRows.length,
          usedGiB: sum(cacheRows, row => row.used),
          unusedGiB: sum(cacheRows, row => !row.used),
          shellGiB: sum(cacheRows, row => /^shell-/i.test(row.uri)),
          fineGiB: sum(cacheRows, row => /^fine-/i.test(row.uri)),
          selectedFineGiB: sum(cacheRows, row => /^fine-/i.test(row.uri) && row.selected),
          attachedFineGiB: sum(cacheRows, row => /^fine-/i.test(row.uri) && row.attached),
        },
      };
    })()`);
    const assertStrictCoverage = (sample, label) => {
      assert.deepEqual(sample.replacementViolations, [], `${label}: parent and descendant rendered together`);
      assert.deepEqual(sample.coverageGaps, [], `${label}: strict REPLACE coverage gap`);
      assert.ok(sample.diagnostics.attachedVisibleTiles > 0, `${label}: no attached visible coverage`);
      assert.ok(sample.diagnostics.cache.usedMiB <= sample.diagnostics.cache.maxMiB,
        `${label}: cache crossed hard cap: ${JSON.stringify({ cache: sample.diagnostics.cache, trace: sample.admissionTrace })}`);
    };

    let pressureSample = null;
    let lastPressureSample = null;
    let peakCacheMiB = 0;
    let deadlockStartedAt = null;
    let maximumBlockedMs = 0;
    const updateDeadlockWindow = (sample) => {
      const diagnostics = sample.diagnostics;
      peakCacheMiB = Math.max(peakCacheMiB, diagnostics.cache.usedMiB || 0);
      const blocked = diagnostics.cache.full && diagnostics.pendingRequiredTiles > 0
        && !diagnostics.queues.download && !diagnostics.queues.parse && !diagnostics.queues.process;
      if (blocked) {
        deadlockStartedAt ??= Date.now();
        maximumBlockedMs = Math.max(maximumBlockedMs, Date.now() - deadlockStartedAt);
      } else {
        deadlockStartedAt = null;
      }
    };
    const pressureDeadline = Date.now() + 45_000;
    while (Date.now() < pressureDeadline) {
      const sample = await sampleRuntime();
      lastPressureSample = sample;
      assertStrictCoverage(sample, 'broad-view admission');
      updateDeadlockWindow(sample);
      // The pressure scalar and the renderer's per-owner targets are applied
      // on adjacent animation frames. Sample only after both sides of that
      // contract are observable so this assertion cannot catch the transient
      // frame between them.
      if (sample.diagnostics.peripheralPressureScale > 1
        && sample.peripheralTargets.some(value => value > 5.481)) {
        pressureSample = sample;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(pressureSample, `production-weighted broad view never activated adaptive peripheral pressure: ${JSON.stringify({
      diagnostics: lastPressureSample?.diagnostics,
      attachedFine: lastPressureSample?.attachedFine,
      cachedFine: lastPressureSample?.cachedFine,
      selectedFine: lastPressureSample?.selectedFine,
      peripheralTargets: lastPressureSample?.peripheralTargets,
      ownerRows: lastPressureSample?.ownerRows,
      cacheBreakdown: lastPressureSample?.cacheBreakdown,
      admissionTrace: lastPressureSample?.admissionTrace,
      peakCacheMiB,
      maximumBlockedMs,
    })}`);
    assert.equal(pressureSample.diagnostics.rawErrorTarget, 5.481);
    assert.equal(pressureSample.diagnostics.errorTarget, 5.481,
      'memory pressure mutated the global requested SSE');
    assert.ok(pressureSample.diagnostics.peripheralPressureScale >= 2
      && pressureSample.diagnostics.peripheralPressureScale <= 4, JSON.stringify(pressureSample.diagnostics));
    assert.ok(pressureSample.cachedFine < 155 && pressureSample.attachedFine < 155,
      `broad peripheral frontier was not bounded: ${JSON.stringify({ cached: pressureSample.cachedFine, attached: pressureSample.attachedFine })}`);
    assert.ok(pressureSample.peripheralTargets.some(value => value > 5.481),
      `peripheral targets did not adapt above raw Detail 20: ${JSON.stringify(pressureSample.peripheralTargets)}`);
    assert.ok(peakCacheMiB > 3072 && peakCacheMiB <= 3840,
      `fixture did not exercise Auto overflow admission safely: peak=${peakCacheMiB} MiB`);

    const beforeMotion = await sampleRuntime();
    assertStrictCoverage(beforeMotion, 'before tiny motion');
    assert.equal(beforeMotion.centerRows.every(row => row.attached && row.cached && row.scene), true,
      `focal cut was not warm before motion: ${JSON.stringify(beforeMotion.centerRows)}`);
    const centerScenes = Object.fromEntries(beforeMotion.centerRows.map(row => [row.uri, row.scene]));
    const requestCountsBefore = new Map(beforeMotion.cachedFineUris.map(uri => [
      uri,
      fixture.requests.filter(requestPath => requestPath.endsWith(`/${uri}`)).length,
    ]));
    const canvas = await client.evaluate(`(() => { const r=document.querySelector('#three-container canvas').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const sampleMovement = async (label) => {
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const sample = await sampleRuntime();
        assertStrictCoverage(sample, label);
        updateDeadlockWindow(sample);
        assert.equal(sample.centerRows.every(row => row.attached && row.cached), true,
          `${label}: tiny movement dropped the warm focal cut`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    for (const pixels of [1, 2, 4, 8]) {
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'right', buttons: 2, clickCount: 1,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 2,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 0, clickCount: 1,
      });
      await sampleMovement(`${pixels}-pixel pan`);
    }
    await client.command('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await client.command('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: canvas.x + 4, y: canvas.y, button: 'left', buttons: 1,
    });
    await client.command('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: canvas.x + 4, y: canvas.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sampleMovement('4-pixel orbit');

    const afterMotion = await sampleRuntime();
    assertStrictCoverage(afterMotion, 'after tiny motion');
    assert.deepEqual(Object.fromEntries(afterMotion.centerRows.map(row => [row.uri, row.scene])), centerScenes,
      'tiny camera movement discarded or recreated the warm focal scenes');
    for (const [uri, before] of requestCountsBefore) {
      const after = fixture.requests.filter(requestPath => requestPath.endsWith(`/${uri}`)).length;
      assert.equal(after, before, `tiny movement re-fetched cached ${uri}: ${JSON.stringify(beforeMotion.cachedFineStates.find(row => row.uri === uri))}`);
    }

    const finalRecoveryDeadline = Date.now() + 8_000;
    let finalBlockedSample = null;
    while (deadlockStartedAt !== null && Date.now() < finalRecoveryDeadline) {
      finalBlockedSample = await sampleRuntime();
      assertStrictCoverage(finalBlockedSample, 'post-motion pressure recovery');
      updateDeadlockWindow(finalBlockedSample);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(deadlockStartedAt, null,
      `cache admission remained idle and blocked for ${maximumBlockedMs} ms after tiny motion: ${JSON.stringify({
        diagnostics: finalBlockedSample?.diagnostics,
        cacheBreakdown: finalBlockedSample?.cacheBreakdown,
        admissionTrace: finalBlockedSample?.admissionTrace,
      })}`);
    assert.ok(maximumBlockedMs < 8_000,
      `cache admission recovery exceeded its bounded pressure window: ${maximumBlockedMs} ms`);
    const fineRequests = fixture.requests.filter(fineRequest);
    const uniqueFineRequests = new Set(fineRequests);
    assert.ok(uniqueFineRequests.size >= 15 && uniqueFineRequests.size <= 155,
      `unexpected production frontier request count: ${uniqueFineRequests.size}`);
    const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
      && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
    assert.deepEqual(exceptions, []);
    t.diagnostic(JSON.stringify({
      shellTiles: shellCount,
      fineTiles: 155,
      requestedFineUrls: uniqueFineRequests.size,
      focalOwner: focalOwner.uri,
      focalLeaves: focalCut.attachedChildren,
      rawDetail20: pressureSample.diagnostics.rawErrorTarget,
      peripheralPressureScale: pressureSample.diagnostics.peripheralPressureScale,
      peakCacheMiB,
      hardCacheMiB: pressureSample.diagnostics.cache.maxMiB,
      cachedFineAtPressure: pressureSample.cachedFine,
      attachedFineAtPressure: pressureSample.attachedFine,
      maximumBlockedMs,
    }));
    await client.evaluate(`window.__restoreProductionWeights?.()`);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (vite) await vite.close();
    rmSync(tileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('depth-stacked strict REPLACE requires regional content to isolate a cold same-parent sibling', async () => {
  // Exercise the real traversal, without renderer policy or network timing.
  // A leaf-only parent cannot simultaneously cover a cold sibling and retain
  // a visible fine child without overlap; merely retaining its cache is not
  // sufficient. An authored intermediate proxy makes that cut possible.
  const { runTraversal } = await import('3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js');
  const makeTile = (name, error, loaded = true, inView = true, children = []) => {
    const tile = {
      name, geometricError: error, refine: 'REPLACE', children, inView,
      internal: { hasContent: true, hasRenderableContent: true, hasUnrenderableContent: false,
        loadingState: loaded ? 4 : 0, depth: 0 },
      traversal: { lastFrameVisited: -1, active: false, visible: false, used: false },
    };
    for (const child of children) child.parent = tile;
    return tile;
  };
  const createRenderer = fallbacks => ({
    frameCount: 0, errorTarget: 5.481, maxDepth: Infinity,
    loadAncestors: false, loadSiblings: false, lodFallbackTiles: new Set(fallbacks),
    stats: { active: 0, visible: 0, used: 0, inFrustum: 0 },
    ensureChildrenArePreprocessed() {}, markTileUsed() {}, queueTileForDownload() {},
    invokeOnePlugin() {},
    calculateTileViewErrorWithPlugin(tile, target) {
      target.inView = tile.inView;
      target.error = tile.geometricError * 100;
      target.distanceFromCamera = 20;
    },
  });
  const step = (tile, renderer) => { renderer.frameCount++; runTraversal(tile, renderer); };
  const near = makeTile('near fine', 0);
  const rear = makeTile('rear fine', 0, false, false);
  const unsplit = makeTile('whole owner', 64, true, true, [near, rear]);
  const unsplitRenderer = createRenderer([unsplit]);
  step(unsplit, unsplitRenderer);
  assert.equal(near.traversal.visible, true);
  assert.equal(unsplit.traversal.visible, false);
  rear.inView = true;
  step(unsplit, unsplitRenderer);
  assert.equal(near.internal.loadingState, 4, 'near fine remains decoded');
  assert.equal(near.traversal.visible, false, 'cold direct sibling forces the only complete parent fallback');
  assert.equal(unsplit.traversal.visible, true);
  rear.internal.loadingState = 4;
  step(unsplit, unsplitRenderer);
  assert.equal(near.traversal.visible && rear.traversal.visible, true);
  assert.equal(unsplit.traversal.visible, false);

  const localNear = makeTile('near fine', 0);
  const localRear = makeTile('rear fine', 0, false, false);
  const nearRegion = makeTile('near proxy', 1, true, true, [localNear]);
  const rearRegion = makeTile('rear proxy', 1, true, false, [localRear]);
  const regional = makeTile('whole owner', 64, true, true, [nearRegion, rearRegion]);
  const regionalRenderer = createRenderer([regional, nearRegion, rearRegion]);
  step(regional, regionalRenderer);
  assert.equal(localNear.traversal.visible, true);
  rearRegion.inView = localRear.inView = true;
  step(regional, regionalRenderer);
  assert.equal(localNear.traversal.visible, true, 'regional rear coverage leaves the near fine cut intact');
  assert.equal(rearRegion.traversal.visible, true, 'the cold rear region has its own complete fallback');
  assert.equal(regional.traversal.visible || nearRegion.traversal.visible || localRear.traversal.visible, false,
    'no REPLACE ancestor overlaps a rendered descendant');
});

test('depth-stacked cross-owner cached regional fallback preserves A foreground after focus moves to B', async () => {
  const { runTraversal } = await import('3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js');
  const { createLodRegionalFallbackCoordinator } = await import('../lod-regional-fallback.mjs');
  const cache = new Map(), marked = new Set(), requests = [], listeners = new Map();
  const makeTile = (name, error, loaded = true, inView = true, children = []) => {
    const tile = {
      content: { uri: name }, geometricError: error, refine: 'REPLACE', children, inView,
      internal: { hasContent: true, hasRenderableContent: true, hasUnrenderableContent: false,
        loadingState: loaded ? 4 : 0, depth: 0 },
      traversal: { lastFrameVisited: -1, active: false, visible: false, used: false },
      engineData: { boundingVolume: {}, scene: loaded ? { identity: name } : null },
    };
    for (const child of children) child.parent = tile;
    if (loaded) cache.set(tile, 64 * 1024 * 1024);
    return tile;
  };
  const owner = name => {
    const near = makeTile(`${name}/near-fine`, 0);
    const rear = makeTile(`${name}/rear-fine`, 0, false, false);
    const nearProxy = makeTile(`${name}/near-proxy`, 1, true, true, [near]);
    const rearProxy = makeTile(`${name}/rear-proxy`, 1, true, false, [rear]);
    const base = makeTile(`${name}/owner`, 64, true, true, [nearProxy, rearProxy]);
    return { base, near, rear, nearProxy, rearProxy };
  };
  const a = owner('a'), b = owner('b');
  const rootTile = makeTile('root', 128, true, true, [a.base, b.base]);
  const renderer = {
    root: rootTile, frameCount: 0, errorTarget: 5.481, maxDepth: Infinity,
    loadAncestors: false, loadSiblings: false, lodFallbackTiles: new Set([a.base, b.base]),
    stats: { active: 0, visible: 0, used: 0, inFrustum: 0 },
    lruCache: {
      maxBytesSize: 3 * GiB, has: tile => cache.has(tile), getMemoryUsage: tile => cache.get(tile) || 0,
      get cachedBytes() { return [...cache.values()].reduce((sum, bytes) => sum + bytes, 0); },
      isFull() { return this.cachedBytes >= this.maxBytesSize; },
    },
    ensureChildrenArePreprocessed() {}, markTileUsed(tile) { marked.add(tile); },
    queueTileForDownload() {}, invokeOnePlugin() {}, removeUnusedPendingTiles() {},
    getBytesUsed: tile => cache.get(tile) || 0,
    requestTileContents(tile) { requests.push(tile); },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    calculateTileViewErrorWithPlugin(tile, target) {
      target.inView = tile.inView;
      target.error = tile.geometricError * 100;
      target.distanceFromCamera = 20;
    },
  };
  const coordinator = createLodRegionalFallbackCoordinator(renderer);
  const update = (candidateOwner, now) => coordinator.update({
    enabled: true, baseTiles: [a.base, b.base], candidateOwner, now, maxBytes: 256 * 1024 * 1024,
  });
  const step = () => { renderer.frameCount++; runTraversal(rootTile, renderer); };
  try {
    b.base.inView = false;
    assert.equal(update(a.base, 0).phase, 'ready');
    step();
    const nearScene = a.near.engineData.scene;
    assert.equal(a.near.traversal.visible, true);
    b.base.inView = true;
    update(b.base, 100);
    step();
    marked.clear();
    assert.equal(update(b.base, 2_101).phase, 'ready');
    step();
    assert.deepEqual(coordinator.retainedTiles(), [b.nearProxy, b.rearProxy],
      'historical A coverage must not consume a second pin budget');
    assert.equal(marked.has(a.rearProxy), false, 'off-screen historical A proxy is not pinned');
    assert.equal(renderer.lodFallbackTiles.has(a.rearProxy), true,
      'naturally cached complete A coverage must retain fallback eligibility');
    assert.equal(requests.length, 0, 'metadata-only owner switching must not re-request cached proxies');

    // B remains focused for over two seconds while the same A foreground is
    // still visible. Newly revealed A background is cold but its proxy is not.
    a.rearProxy.inView = a.rear.inView = true;
    update(b.base, 2_201);
    step();
    assert.equal(a.near.traversal.visible && a.rearProxy.traversal.visible && b.near.traversal.visible, true);
    assert.equal(a.near.engineData.scene, nearScene);
    assert.equal(cache.has(a.near), true);
    assert.equal(a.base.traversal.visible || a.nearProxy.traversal.visible || a.rear.traversal.visible, false,
      'A regional fallback must not overlap its fine foreground or cold leaf');
    assert.ok(renderer.lruCache.cachedBytes <= renderer.lruCache.maxBytesSize);

    // A real cache eviction is different from a focus change. A partial old
    // cover must lose eligibility and may legitimately return to its parent.
    cache.delete(a.rearProxy);
    a.rearProxy.internal.loadingState = 0;
    a.rearProxy.engineData.scene = null;
    listeners.get('dispose-model')?.({ tile: a.rearProxy });
    assert.equal(renderer.lodFallbackTiles.has(a.nearProxy) || renderer.lodFallbackTiles.has(a.rearProxy), false);
    update(b.base, 2_301);
    step();
    assert.equal(a.base.traversal.visible, true, 'real regional eviction retains complete parent coverage');
    assert.equal(a.near.traversal.visible || a.nearProxy.traversal.visible || a.rear.traversal.visible, false);
    assert.equal(b.near.traversal.visible, true, 'A eviction must not collapse focused B');
    assert.equal(requests.length, 0, 'historical eviction must not trigger optional reloads');
  } finally {
    coordinator.dispose();
  }
});

for (const { sameOwner, twoNear } of [{ sameOwner: false }, { sameOwner: true }, { sameOwner: true, twoNear: true }]) {
  test(`depth-stacked ${twoNear ? 'two-near-wall ' : ''}${sameOwner ? 'same-owner regional' : 'different-owner'} LOD preserves the near fine surface through sustained pitch and orbit`, { timeout: 180_000 }, async (t) => {
    const executable = browserPath();
    if (!executable) {
      t.skip('Chrome or Edge is required for depth-stacked LOD acceptance.');
      return;
    }
    const releaseLock = await acquireBrowserHarnessLock({ root });
    let browser, profile, server, vite, client;
    try {
      const data = depthStackedAcceptanceFixture({ sameOwner, twoNear });
      const fixture = await startFixture(path.join(root, 'test', 'fixtures', 'ktx2-tiles'), {
        ...data,
        forceOptimizeDeps: true,
        assetDelayMs: uri => uri === 'coarse/root.b3dm' ? 1_500
          : /^rear-.*\/region\.b3dm$/.test(uri) ? 150
            : /^rear-.*\/fine-/.test(uri) ? 1_200 : 50,
      });
      ({ server, vite } = fixture);
      profile = mkdtempSync(path.join(tmpdir(), 'ltds-depth-stacked-browser-'));
      const devToolsPort = await reserveDevToolsPort();
      browser = spawn(executable, [
        '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
        '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
      ], { stdio: 'ignore' });
      const devTools = await waitForDevTools(devToolsPort, browser);
      const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
      client = await CdpClient.connect(target.webSocketDebuggerUrl);
      for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await client.command(method);
      await client.command('Page.addScriptToEvaluateOnNewDocument', {
        source: 'Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => 8 });',
      });
      await client.command('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        screenWidth: 1440, screenHeight: 900,
      });
      await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model&lodDistanceDemand=0` });
      await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.children?.length)', 'depth-stacked hierarchy did not initialize', 20_000);
      await setView(client, [0, 0, 20], [0, 0, 0]);
      await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const weights = ${JSON.stringify(data.logicalMiB)};
        const originalGetBytesUsed = tiles.getBytesUsed;
        const decoded = new WeakSet();
        const uri = tile => String(tile?.content?.uri || tile?.content?.url || '').split(/[?#]/, 1)[0];
        tiles.getBytesUsed = function(tile) {
          if (tile?.engineData?.scene) decoded.add(tile);
          return decoded.has(tile) && Object.hasOwn(weights, uri(tile))
            ? weights[uri(tile)] * 1024 * 1024 : originalGetBytesUsed.call(this, tile);
        };
        window.__depthPressureEvents = 0;
        window.__depthEvents = { pressure: {}, downloads: {}, loads: {}, disposals: {} };
        const count = (name, key) => {
          const counts = window.__depthEvents[name]; counts[key] = (counts[key] || 0) + 1;
        };
        tiles.addEventListener('tile-memory-pressure', event => {
          window.__depthPressureEvents++;
          count('pressure', uri(event.tile) + '|state=' + event.tile?.internal?.loadingState);
        });
        for (const [eventName, counter] of [['tile-download-start', 'downloads'], ['load-model', 'loads'], ['dispose-model', 'disposals']]) {
          tiles.addEventListener(eventName, event => count(counter, uri(event.tile)));
        }
        return true;
      })()`);
      await waitFor(client, `(() => {
        const tiles = window.__ltds.tiles(), expected = ${JSON.stringify(data.nearUris)};
        let fine = 0;
        const visit = tile => {
          if (expected.includes(tile.content?.uri || tile.content?.url || '') && tile.traversal?.visible
            && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) fine++;
          (tile.children || []).forEach(visit);
        };
        visit(tiles.root);
        return fine === expected.length && window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete';
      })()`, 'near wall never acquired its complete fine frontier', 30_000);
      assert.equal(fixture.requests.some(uri => /\/rear-.*\/fine-/.test(uri)), false,
        'fixture failed to keep the rear fine frontier cold before the pitch');

      const sampleExpression = `(() => {
        const tiles = window.__ltds.tiles(), camera = window.__ltds.camera();
        const expected = ${JSON.stringify(data.nearUris)};
        const uri = tile => tile?.content?.uri || tile?.content?.url || '';
        const visible = tile => Boolean(tile?.traversal?.visible && tile.engineData?.scene?.visible !== false
          && tiles.group.children.includes(tile.engineData.scene));
        const near = [], overlaps = [], rows = [], visibleScenes = [];
        const visit = (tile, renderedAncestor = null) => {
          const rendered = visible(tile);
          if (rendered && renderedAncestor) overlaps.push([renderedAncestor, uri(tile)]);
          if (rendered) visibleScenes.push(tile.engineData.scene);
          if (expected.includes(uri(tile))) near.push({
            uri: uri(tile), visible: rendered, cached: tiles.lruCache.has(tile),
            scene: tile.engineData?.scene?.uuid || null,
            inFrustum: tile.traversal?.inFrustum === true,
            effectiveTarget: tile.__ltdsPeripheralErrorTarget,
          });
          rows.push({ uri: uri(tile), visible: rendered, used: tile.traversal?.used === true,
            inFrustum: tile.traversal?.inFrustum === true, loading: tile.internal?.loadingState,
            rawError: tile.traversal?.error, effectiveTarget: tile.__ltdsPeripheralErrorTarget,
            focal: tile.__ltdsFocalOwnerLocked === true });
          (tile.children || []).forEach(child => visit(child, rendered ? uri(tile) : renderedAncestor));
        };
        visit(tiles.root);
        camera.updateMatrixWorld(true);
        tiles.group.updateWorldMatrix(true, true);
        const Vector3 = camera.position.constructor;
        const Raycaster = window.__ltds.controls()._raycaster.constructor;
        const raycaster = new Raycaster(); raycaster.firstHitOnly = true;
        const points = ${JSON.stringify(data.nearPoints)}.map(([x, y, z]) => {
          const ndc = new Vector3(x, y, z).project(camera);
          const onScreen = Math.abs(ndc.x) < 0.98 && Math.abs(ndc.y) < 0.98 && Math.abs(ndc.z) < 1;
          raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
          const hit = raycaster.intersectObjects(visibleScenes, true)[0];
          let scene = hit?.object || null;
          while (scene && !tiles.group.children.includes(scene)) scene = scene.parent;
          const fineHit = near.some(row => row.visible && row.scene === scene?.uuid);
          return { x, onScreen, fineHit, ndc: [ndc.x, ndc.y] };
        });
        const rearPoints = ${JSON.stringify(data.rearPoints)}.map(position => {
          const ndc = new Vector3(...position).project(camera);
          const onScreen = Math.abs(ndc.x) < 0.95 && Math.abs(ndc.y) < 0.95 && Math.abs(ndc.z) < 1;
          raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
          return { position, onScreen, covered: Boolean(raycaster.intersectObjects(visibleScenes, true)[0]) };
        });
        return {
          near, overlaps, points, rearPoints, rows, diagnostics: window.__ltds.lodDiagnostics(),
          fallbackUris: [...(tiles.lodFallbackTiles || [])].map(uri),
          cacheBytes: tiles.lruCache.cachedBytes, hardBytes: tiles.lruCache.maxBytesSize,
          pressureEvents: window.__depthPressureEvents,
        };
      })()`;
      const baseline = await client.evaluate(sampleExpression);
      assert.equal(baseline.points.every(point => point.onScreen && point.fineHit), true,
        `depth fixture has no real near-surface coverage: ${JSON.stringify(baseline)}`);
      const baselineScenes = Object.fromEntries(baseline.near.map(row => [row.uri, row.scene]));
      const requestCounts = new Map(data.nearUris.map(uri => [uri,
        fixture.requests.filter(request => request.endsWith(`/${uri}`)).length]));
      const samples = [];
      const sample = async label => {
        const value = await client.evaluate(sampleExpression);
        samples.push({ label, ...value });
        return value;
      };
      // Hold a real orbit gesture while exact public camera poses isolate
      // projection changes from pointer sensitivity. Both active-motion and
      // settling paths run, and all near test points stay on screen. This
      // continuous gesture exceeds the old two-second recent-cut TTL.
      const gesture = await client.evaluate(`(() => {
        const bounds = window.__ltds.controls().dom.getBoundingClientRect();
        const ndc = ${JSON.stringify(twoNear ? baseline.points[1].ndc : [0, 0])};
        return { x: bounds.left + bounds.width * (ndc[0] + 1) / 2,
          y: bounds.top + bounds.height * (1 - ndc[1]) / 2 };
      })()`);
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...gesture, button: 'left', buttons: 1, clickCount: 1,
      });
      assert.equal(await client.evaluate('window.__ltds.controls().getInteractionState().activeMotion'), true,
        'near-surface orbit gesture did not activate');
      const motionStart = Date.now();
      for (let step = 0; step <= 30; step++) {
        const pitch = (5 + step * 0.5) * Math.PI / 180;
        await setView(client, [0, 0, 20], [0, Math.tan(pitch) * 20, 0]);
        await new Promise(resolve => setTimeout(resolve, 100));
        await sample(`pitch-${5 + step * 0.5}`);
      }
      for (let step = 0; step <= 30; step++) {
        const yaw = (twoNear ? 0.5 * Math.sin(step / 5) : 5 + step * 0.5) * Math.PI / 180;
        await setView(client, [Math.sin(yaw) * 20, 0, Math.cos(yaw) * 20], [0, Math.tan(20 * Math.PI / 180) * 20, 0]);
        await new Promise(resolve => setTimeout(resolve, 100));
        await sample(`orbit-${5 + step * 0.5}`);
      }
      assert.ok(Date.now() - motionStart > 2_000, 'motion did not cross the old recent-cut TTL');
      assert.equal(samples.every(value => value.diagnostics.focusPriority.activeMotion), true,
        'continuous depth movement unexpectedly ended its active gesture');
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...gesture, button: 'left', buttons: 0, clickCount: 1,
      });
      const convergenceDeadline = Date.now() + 30_000;
      let final = null, stable = 0;
      while (Date.now() < convergenceDeadline) {
        final = await sample('settling');
        const d = final.diagnostics;
        stable = d.pendingRequiredTiles === 0 && d.pendingHierarchyNodes === 0
          && !d.queues.download && !d.queues.parse && !d.queues.process ? stable + 1 : 0;
        if (stable >= 5) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const summarize = value => ({ label: value.label, near: value.near, points: value.points, rearPoints: value.rearPoints,
        diagnostics: value.diagnostics, visible: value.rows.filter(row => row.visible), overlaps: value.overlaps });
      const badCoverage = samples.find(value => value.near.length !== data.nearUris.length
        || value.near.some(row => !row.visible || !row.cached || row.scene !== baselineScenes[row.uri])
        || value.points.some(point => !point.onScreen || !point.fineHit));
      const badOverlap = samples.find(value => value.overlaps.length);
      const rearGap = samples.find(value => value.rearPoints.some(point => point.onScreen && !point.covered));
      const badCap = samples.find(value => value.cacheBytes > value.hardBytes);
      const peakMiB = Math.max(...samples.map(value => value.cacheBytes)) / 1024 / 1024;
      const pressureEvents = Math.max(...samples.map(value => value.pressureEvents));
      const eventCounts = await client.evaluate('window.__depthEvents');
      const fetchCounts = Object.fromEntries([...new Set(fixture.requests.filter(uri => uri.endsWith('.b3dm')))]
        .map(uri => [uri, fixture.requests.filter(request => request === uri).length]));
      t.diagnostic(JSON.stringify({ sameOwner, samples: samples.length, peakMiB, pressureEvents, eventCounts, fetchCounts,
        firstCoverageFailure: badCoverage ? summarize(badCoverage) : null,
        final: final ? summarize(final) : null }));
      assert.ok(!badOverlap, `depth motion rendered a REPLACE ancestor and descendant together: ${JSON.stringify(badOverlap && summarize(badOverlap))}`);
      assert.ok(!rearGap, `depth motion uncovered a newly visible background region: ${JSON.stringify(rearGap && summarize(rearGap))}`);
      assert.ok(!badCap, `depth motion exceeded the hard cache cap: ${JSON.stringify(badCap && summarize(badCap))}`);
      assert.ok(!badCoverage, `depth motion discarded the still-visible near fine surface: ${JSON.stringify(badCoverage && summarize(badCoverage))}`);
      for (const [uri, before] of requestCounts) {
        assert.equal(fixture.requests.filter(request => request.endsWith(`/${uri}`)).length, before,
          `sustained depth motion re-fetched the still-visible ${uri}`);
      }
      assert.ok(peakMiB >= 2_500 || pressureEvents > 0,
        `weighted depth test never exercised substantial residency or admission pressure: ${peakMiB} MiB`);
      assert.ok(stable >= 5, `depth-stacked selected frontier did not converge: ${JSON.stringify(final && summarize(final))}`);
      if (twoNear) {
        assert.equal(final.diagnostics.regionalFallback.nearRegionCount, 2,
          'both equally near walls must receive bounded regional protection');
        assert.ok(final.rows.some(row => /^rear-.*\/region\.b3dm$/.test(row.uri)
          && row.visible && row.effectiveTarget > final.diagnostics.rawErrorTarget),
        'delayed far background must retain relaxed coarse coverage under pressure');
      }
      const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
        && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
      assert.deepEqual(exceptions, []);
    } finally {
      if (client) {
        await client.command('Page.close', {}, 2_000).catch(() => {});
        client.close();
      }
      if (browser) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        browser.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
      }
      if (server) await new Promise(resolve => server.close(resolve));
      if (vite) await vite.close();
      releaseLock();
      await removeBrowserProfile(profile);
    }
  });
}

test('browser camera photo fills the window and preserves source pixels through zoom and bounded pan', { timeout: 90_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) { t.skip('Chrome or Edge is required for photo rendering acceptance.'); return; }
  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  const cases = [
    { name: 'landscape', width: 1440, height: 900, photoWidth: 1536, photoHeight: 1024 },
    { name: 'ultrawide-portrait', width: 2560, height: 1080, photoWidth: 1024, photoHeight: 1536 },
    { name: 'narrow-panorama', width: 390, height: 844, photoWidth: 2048, photoHeight: 512 },
  ];
  try {
    const fixture = await startFixture(path.join(root, 'test', 'fixtures', 'ktx2-tiles'), {
      cameraPhotoBodies: Object.fromEntries(cases.map((item, index) => [`photo-${index}.jpg`, stripedPhotoPng(item.photoWidth, item.photoHeight)])),
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-photo-window-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__photoFullscreenCalls = 0;
      Element.prototype.requestFullscreen = function () { window.__photoFullscreenCalls++; return Promise.reject(new Error('Unexpected device fullscreen')); };
    ` });
    await client.command('Page.navigate', { url: `${fixture.origin}/view/photo-allowed?view=model` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root)', 'photo fixture did not initialize');
    await client.evaluate(`document.querySelector('#layer-cameras').click()`);
    await waitFor(client, 'window.__ltdsCams === 3', 'photo fixture camera positions did not load');
    // Exercise the real shared camera-open handler with its origin, source,
    // correlation, permission and index checks; a point-cloud render is irrelevant here.
    await client.evaluate(`(() => {
      const frame = document.createElement('iframe'); frame.id = 'pc-iframe';
      frame.dataset.correlationId = 'photo-ui-fixture'; frame.src = 'about:blank'; frame.style.display = 'none';
      document.querySelector('#cloud-container').appendChild(frame);
    })()`);
    const readPhoto = () => client.evaluate(`(() => {
      const frame=document.querySelector('#photo-frame'),wrap=document.querySelector('#photo-imgwrap'),img=document.querySelector('#photo-img');
      const title=document.querySelector('#photo-title'),meta=document.querySelector('#photo-meta');
      const rect=e=>{const r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,width:r.width,height:r.height};};
      return {frame:rect(frame),wrap:rect(wrap),image:rect(img),title:rect(title),meta:rect(meta),
        filename:title.textContent,time:meta.textContent,source:img.currentSrc,download:document.querySelector('#photo-download').href,
        downloadVisible:getComputedStyle(document.querySelector('#photo-download')).display!=='none',downloadFilename:document.querySelector('#photo-download').download,
        naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,layoutWidth:img.offsetWidth,
        full:document.fullscreenElement!==null,fullscreenCalls:window.__photoFullscreenCalls};
    })()`);
    const drag = async (x, y, endX, endY) => {
      await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await client.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: endY, button: 'left', buttons: 1 });
      await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 });
    };
    for (const [index, item] of cases.entries()) {
      await client.command('Emulation.setDeviceMetricsOverride', { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: false });
      await client.evaluate(`(() => { const frame=document.querySelector('#pc-iframe');
        window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:frame.contentWindow,
          data:{source:'ltds-pointcloud',type:'camera-open',correlationId:frame.dataset.correlationId,index:${index}}}));
      })()`);
      await waitFor(client, `document.querySelector('#photo-img').naturalWidth === ${item.photoWidth} && document.querySelector('#photo-img').style.opacity === '1' && getComputedStyle(document.querySelector('#photo-img')).opacity === '1'`, `${item.name} original photo did not decode`);
      const docked = await readPhoto();
      assert.equal(docked.naturalHeight, item.photoHeight);
      assert.equal(docked.source, docked.download, 'preview and download must identify the same original image');
      assert.equal(docked.downloadVisible, true, 'permitted original download must be visible');
      assert.equal(docked.downloadFilename, `photo-${index}.jpg`);
      assert.ok(docked.frame.l >= 0 && docked.frame.r <= item.width + 1, `docked photo escaped viewport: ${JSON.stringify(docked)}`);
      assert.ok(Math.abs(docked.image.width / docked.image.height - item.photoWidth / item.photoHeight) < 0.01);
      const photoRequests = () => fixture.requests.filter(uri => uri.includes('/camera-photos/')).length;
      const requestCount = photoRequests();
      if (index === 0 && process.env.LTDS_PHOTO_QA_ARTIFACT_DIR) {
        const shot = await client.command('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path.join(process.env.LTDS_PHOTO_QA_ARTIFACT_DIR, 'photo-docked-qa.png'), Buffer.from(shot.data, 'base64'));
      }
      await client.evaluate(`document.querySelector('#photo-imgwrap').click()`);
      await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'expanded'`, 'photo did not expand');
      const expanded = await readPhoto();
      assert.deepEqual([expanded.frame.l, expanded.frame.t, expanded.frame.r, expanded.frame.b], [0, 0, item.width, item.height], 'inspector must fill browser viewport');
      assert.deepEqual([expanded.wrap.l, expanded.wrap.t, expanded.wrap.r, expanded.wrap.b], [0, 0, item.width, item.height]);
      assert.equal(expanded.filename, `photo-${index}.jpg`);
      assert.ok(expanded.time.length > 0); assert.doesNotMatch(expanded.time, /altitude|MSL|feet|\bft\b/i);
      assert.ok(expanded.title.l <= 20 && expanded.title.b >= item.height - 20, 'filename must remain at lower left');
      assert.ok(expanded.meta.r >= item.width - 20 && expanded.meta.b >= item.height - 20, 'capture time must remain at lower right');
      assert.ok(expanded.title.r <= expanded.meta.l + 1, 'footer labels overlap');
      assert.equal(expanded.full, false); assert.equal(expanded.fullscreenCalls, 0);
      assert.equal(photoRequests(), requestCount, 'expansion fetched the original again');
      await drag(item.width / 2, item.height / 2, 8, 8);
      const fitPanned = await readPhoto();
      assert.deepEqual(fitPanned.image, expanded.image, 'fit-to-window photo must not pan');
      // Zoom exactly to one CSS pixel per source pixel. DPR is explicitly one.
      const factor = item.photoWidth / expanded.image.width;
      await client.evaluate(`document.querySelector('#photo-imgwrap').dispatchEvent(new WheelEvent('wheel', {
        deltaY:${100 * Math.log(factor) / Math.log(0.9)},clientX:${item.width / 2},clientY:${item.height / 2},bubbles:true,cancelable:true
      }))`);
      await waitFor(client, `Math.abs(document.querySelector('#photo-img').getBoundingClientRect().width - ${item.photoWidth}) < 1`, 'photo did not reach native scale');
      const native = await readPhoto();
      assert.ok(Math.abs(native.layoutWidth - item.photoWidth) < 1, 'zoom must give the source a native-size paint surface');
      assert.ok(Math.abs(native.image.height - item.photoHeight) < 1);
      const screenshot = await client.command('Page.captureScreenshot', { format: 'png', clip: { x: item.width / 2 - 32, y: item.height / 2 - 32, width: 64, height: 64, scale: 1 } });
      const pixels = await client.evaluate(`(async () => {
        const image = new Image(); image.src='data:image/png;base64,${screenshot.data}'; await image.decode();
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const row=context.getImageData(0,32,64,1).data;return Array.from({length:64},(_,x)=>row[x*4]);
      })()`);
      assert.ok(pixels.slice(1).filter((value, i) => Math.abs(value - pixels[i]) > 200).length >= 58,
        `${item.name}: native single-pixel source stripes became blurred in the painted overlay: ${pixels.join(',')}`);
      if (index === 0 && process.env.LTDS_PHOTO_QA_ARTIFACT_DIR) {
        const shot = await client.command('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path.join(process.env.LTDS_PHOTO_QA_ARTIFACT_DIR, 'photo-expanded-native-qa.png'), Buffer.from(shot.data, 'base64'));
      }
      for (const [endX, endY] of [[2, 2], [item.width - 2, item.height - 2]]) {
        await drag(item.width / 2, item.height / 2, endX, endY);
        assertPhotoPanBounds(await readPhoto());
      }
      assert.equal(photoRequests(), requestCount, 'zoom and pan fetched another photo representation');
      if (index === 0) {
        const downloadPath = path.join(profile, 'photo-downloads'); mkdirSync(downloadPath);
        await client.command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
        await client.evaluate(`document.querySelector('#photo-download').click()`);
        const filename = path.join(downloadPath, 'photo-0.jpg');
        const deadline = Date.now() + 10_000;
        while (!existsSync(filename) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        assert.ok(existsSync(filename), 'clicking Download Original did not save the named photo');
        assert.deepEqual(readFileSync(filename), stripedPhotoPng(item.photoWidth, item.photoHeight), 'download changed the original response bytes');
      }
      await client.evaluate(`document.querySelector('#photo-close').click()`);
      assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('#photo-modal')).display`), 'none');
    }
    for (const [grant, allowed] of [['photo-staff', true], ['photo-denied', false]]) {
      await client.command('Page.navigate', { url: `${fixture.origin}/view/${grant}?view=model` });
      await waitFor(client, `location.pathname === '/view/${grant}' && Boolean(window.__ltds?.tiles()?.root)`, 'permission fixture did not initialize');
      await client.evaluate(`document.querySelector('#layer-cameras').click()`);
      await waitFor(client, 'window.__ltdsCams === 3', 'permission fixture cameras did not load');
      // A decoded image can expose naturalWidth while its queued load callback
      // has not installed the download state. Hold the old painted opacity to
      // exercise that ordering deterministically, rather than relying on CI load.
      await client.evaluate(`(() => {
        const img=document.querySelector('#photo-img');
        img.style.transitionDelay='1s';
        img.addEventListener('load', event => {
          const complete=img.onload; event.stopImmediatePropagation();
          setTimeout(() => complete?.call(img,event),250);
        },{capture:true,once:true});
      })()`);
      await client.evaluate(`(() => {
        const frame=document.createElement('iframe');frame.id='pc-iframe';frame.dataset.correlationId='download-permission';frame.style.display='none';
        document.querySelector('#cloud-container').appendChild(frame);
        window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:frame.contentWindow,
          data:{source:'ltds-pointcloud',type:'camera-open',correlationId:frame.dataset.correlationId,index:0}}));
      })()`);
      await waitFor(client, `document.querySelector('#photo-img').naturalWidth === 1536 && document.querySelector('#photo-img').style.opacity === '1' && getComputedStyle(document.querySelector('#photo-img')).opacity === '1'`, 'permission fixture photo did not decode');
      const photo = await readPhoto();
      assert.equal(photo.downloadVisible, allowed, `${grant} photo-download permission was ignored`);
      assert.equal(photo.source, photo.download); assert.equal(photo.downloadFilename, 'photo-0.jpg');
      await client.evaluate(`document.querySelector('#photo-imgwrap').click()`);
      assert.equal((await readPhoto()).downloadVisible, allowed, 'expanding a photo changed download permissions');
    }
  } finally {
    if (client) { await client.command('Page.close', {}, 2_000).catch(() => {}); client.close(); }
    if (browser) {
      const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (vite) await vite.close();
    releaseLock(); await removeBrowserProfile(profile);
  }
});

test('browser distance-demand switches at developer Detail 20 protect nearby surfaces with bounded timing and unchanged queue limits', { timeout: 90_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) { t.skip('Chrome or Edge is required for evaluation-switch integration acceptance.'); return; }
  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    // Actual depth-separated geometry: two nearby walls and eight background
    // patches, not a coplanar grid. Coarse SSE is about 400 at this fixed pose.
    // Synthetic content tests integration, not Church visual acceptability.
    const encoded = readFileSync(path.join(root,'test','fixtures','ktx2-tiles','LOD-0','Mesh.b3dm'));
    const glbOffset = 28+[12,16,20,24].reduce((total,offset)=>total+encoded.readUInt32LE(offset),0);
    const glb = encoded.subarray(glbOffset), jsonLength=glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20,20+jsonLength).toString('utf8'));
    const image = gltf.images.find(value=>value.mimeType==='image/ktx2');
    assert.ok(image,'committed compressed fixture must contain an actual KTX2 image');
    const imageView=gltf.bufferViews[image.bufferView], imageOffset=28+jsonLength+(imageView.byteOffset||0);
    const compressedImage=glb.subarray(imageOffset,imageOffset+imageView.byteLength);
    const bodies = {}, rootTriangles = [];
    const branch = (name, x, y, z, radius, error) => {
      const triangles = [
        [[x-radius/2,y-radius/2,z],[x+radius/2,y-radius/2,z],[x-radius/2,y+radius/2,z]],
        [[x+radius/2,y-radius/2,z],[x+radius/2,y+radius/2,z],[x-radius/2,y+radius/2,z]],
      ];
      rootTriangles.push(...triangles);
      const body = makeB3dm(makeGlb(triangles, compressedImage, {basisu:true}));
      const uri = `${name}/root.b3dm`, leaf = `LOD-0/${name}.b3dm`;
      bodies[uri] = body; bodies[leaf] = body;
      return { name, refine:'REPLACE', boundingVolume:{ sphere:[x,y,z,radius] }, geometricError:error,
        content:{ uri }, children:[{ name:`${name}-leaf`, refine:'REPLACE', geometricError:0,
          boundingVolume:{ sphere:[x,y,z,radius] }, content:{ uri:leaf } }] };
    };
    const near = [branch('near-left',-2,0,-8,1,3), branch('near-right',2,0,-8,1,3)];
    const background = Array.from({ length:8 }, (_,i) => {
      const x=(i%4-1.5)*8, y=(Math.floor(i/4)-0.5)*10, z=-65-i;
      return branch(`background-${i}`,x,y,z,2,400*(Math.hypot(x,y,z)-2)*2*Math.tan(Math.PI/6)/900);
    });
    bodies['coarse/root.b3dm'] = makeB3dm(makeGlb(rootTriangles, compressedImage, {basisu:true}));
    const fixture = await startFixture(path.join(root,'test','fixtures','ktx2-tiles'), {
      tilesetJson:{ asset:{ version:'1.0', gltfUpAxis:'Z' }, geometricError:1000,
        root:{ boundingVolume:{ sphere:[0,0,-40,100] }, geometricError:1000, refine:'REPLACE',
          content:{ uri:'coarse/root.b3dm' }, children:[...near,...background] } },
      assetBodies:bodies, configureConfig:config => { config.georef.bboxCenter={x:0,y:0,z:0}; },
    });
    ({ server,vite } = fixture);
    profile=mkdtempSync(path.join(tmpdir(),'ltds-evaluation-switches-'));
    const port=await reserveDevToolsPort();
    browser=spawn(executable,[ '--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--no-sandbox',
      '--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank' ],{stdio:'ignore'});
    const devTools=await waitForDevTools(port,browser);
    const target=await (await fetch(`${devTools}/json/new?about:blank`,{method:'PUT'})).json();
    client=await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable'); await client.command('Runtime.enable');
    await client.command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    const results=[];
    for (const {enabled,query} of [
      {enabled:false,query:'&lodDistanceDemand=0'},
      {enabled:true,query:'&lodLoadingTiming=1'},
      {enabled:true,query:'&lodDistanceDemand=1&lodLoadingTiming=1'},
    ]) {
      await client.command('Page.navigate',{url:`${fixture.origin}/?project=${fixtureId}&view=model${query}`});
      await waitFor(client, `window.__ltds?.state?.lodRuntimeProfile?.bootstrapPhase==='complete'`, 'evaluation fixture bootstrap did not complete',20_000);
      // Maximum Detail 24 intentionally bypasses distance-demand coarsening.
      // Exercise this retained developer policy at its specified Detail 20.
      await client.evaluate(`(() => {const slider=document.querySelector('#lod-detail');slider.value='20';slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await client.evaluate(`(() => {const tiles=window.__ltds.tiles(),cam=window.__ltds.camera(),V=cam.position.constructor;
        tiles.group.updateWorldMatrix(true,false);
        window.__evaluationPoseFrame=tiles.frameCount;
        window.__evaluationSettled=null;
        window.__ltds.controls().setView(new V(0,0,0).applyMatrix4(tiles.group.matrixWorld),new V(0,0,-20).applyMatrix4(tiles.group.matrixWorld));
      })()`);
      // A parse completion can empty every queue before the following traversal
      // replaces its coarse parent. Require a stable, work-free frontier across
      // subsequent frames; do not confuse LOADED geometry with visible geometry.
      // This does not require the expected leaf selection: assertions below must
      // still reject a stable but incorrect policy result.
      await waitFor(client, `(() => {
        const t=window.__ltds.tiles(),queues=[t.downloadQueue,t.parseQueue,t.processNodeQueue];
        const quiet=t.frameCount>window.__evaluationPoseFrame+2 && t.root.children.every(b=>b.traversal?.inFrustum)
          && queues.every(q=>!q.running && q.items.length===0) && !t.stats.queued && !t.stats.downloading && !t.stats.parsing;
        if(!quiet){window.__evaluationSettled=null;return false;}
        const signature=JSON.stringify(t.root.children.map(b=>[b.internal.loadingState,b.children[0].internal.loadingState,t.visibleTiles.has(b),t.visibleTiles.has(b.children[0])]));
        const previous=window.__evaluationSettled;
        if(!previous||previous.signature!==signature){window.__evaluationSettled={frame:t.frameCount,signature};return false;}
        return t.frameCount>=previous.frame+3;
      })()`, 'fixed-pose evaluation did not settle',15_000);
      const result=await client.evaluate(`(() => {const t=window.__ltds.tiles();return {
        options:window.__ltds.lodEvaluation(),note:!document.querySelector('#lod-evaluation-note').hidden,
        timing:window.__ltds.lodLoadingTiming(),owner:window.__ltds.lodOwnerDiagnostics(),raw:t.errorTarget,
        readiness:{frame:t.frameCount,poseFrame:window.__evaluationPoseFrame,stats:{...t.stats},queues:[t.downloadQueue,t.parseQueue,t.processNodeQueue].map(q=>({running:q.running,queued:q.items.length}))},
        loadingSamples:window.__ltds.lodTrace().map(entry=>entry.snapshot.loadingBudget).filter(Boolean),
        limits:{downloads:t.downloadQueue.maxJobs,parses:t.parseQueue.maxJobs,
          workers:t.plugins.find(p=>p.ktxLoader)?.ktxLoader.workerPool.pool,soft:t.lruCache.minBytesSize,hard:t.lruCache.maxBytesSize},
        branches:t.root.children.map(b=>({name:b.name,target:b.__ltdsPeripheralErrorTarget,sse:b.traversal.error,
          demand:b.__ltdsDistanceDemand,parentVisible:t.visibleTiles.has(b),leafVisible:t.visibleTiles.has(b.children[0]),refine:b.refine,leafState:b.children[0].internal.loadingState}))
      };})()`);
      assert.deepEqual(result.options,{distanceDemand:enabled,loadingTiming:enabled});
      assert.ok(result.loadingSamples.length > 0, 'real-browser loading admission telemetry is required');
      assert.ok(result.loadingSamples.every(sample => sample.enabled && sample.inFlight <= sample.maxInFlight && sample.maxInFlight <= 8),
        'whole download/body/parse lifetimes exceeded the bounded loading window');
      assert.equal(result.note,enabled); assert.equal(result.owner.distanceDemandEnabled,enabled);
      assert.ok(Math.abs(result.raw-5.481)<0.01);
      if (!enabled) {
        assert.equal(result.timing,null);
        assert.ok(result.branches.every(b=>Math.abs(b.target-result.raw)<0.01),JSON.stringify(result.branches));
        assert.ok(result.branches.every(b=>b.leafVisible), `baseline must select all high-SSE terminal leaves: ${JSON.stringify({readiness:result.readiness,branches:result.branches})}`);
      } else {
        assert.ok(result.branches.filter(b=>b.name.startsWith('background')&&b.target>100).length>=6,JSON.stringify(result.branches));
        assert.ok(result.branches.filter(b=>b.name.startsWith('background')&&b.parentVisible&&!b.leafVisible).length>=6,
          `medium demand did not decrease: ${JSON.stringify(result.branches)}`);
        for (const b of result.branches.filter(b=>b.name.startsWith('near'))) {
          assert.equal(b.demand.protected,true,JSON.stringify(b)); assert.equal(b.target,result.raw,JSON.stringify(b)); assert.equal(b.leafVisible,true,JSON.stringify(b));
        }
        assert.ok(result.branches.every(b=>b.refine==='REPLACE' && b.parentVisible!==b.leafVisible), 'every branch must render parent or leaf, not both');
        assert.equal(result.timing.enabled,true); assert.equal(result.timing.capacity,256);
        assert.ok(result.timing.records.length>0 && result.timing.records.length<=256);
        for(const stage of ['parse-enqueued','parse-start','parse-end','model-ready','ktx-enqueued','ktx-start','ktx-end']) assert.ok(result.timing.aggregates[stage]?.count>0,stage);
        assert.doesNotMatch(JSON.stringify(result.timing),/https?:|\.b3dm|token|secret/);
        assert.ok(result.owner.tiles.some(row=>row.distanceDemand?.target>100));
      }
      results.push(result);
    }
    assert.deepEqual(results[1].limits,results[0].limits,'evaluation changed concurrency or memory budget');
    assert.deepEqual(results[2].limits,results[0].limits,'explicit-on changed concurrency or memory budget');
    const selection = value => value.branches.map(({name,target,parentVisible,leafVisible})=>({name,target,parentVisible,leafVisible}));
    assert.deepEqual(selection(results[2]),selection(results[1]),'explicit-on differs from default-on at the same pose');
    assert.equal(results[1].limits.workers,2);
  } finally {
    if(client){await client.command('Page.close',{},2_000).catch(()=>{});client.close();}
    if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5_000))]);}
    if(server)await new Promise(resolve=>server.close(resolve));
    if(vite)await vite.close();
    releaseLock();await removeBrowserProfile(profile);
  }
});

test('browser defaults to orthophoto when LOD is unavailable and tears down point-cloud runtime across history navigation', { timeout: 60_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for view lifecycle browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  const started = Date.now();
  const stage = async (label, expression) => {
    t.diagnostic(`lifecycle entering ${label} at ${Date.now()-started}ms`);
    await waitFor(client, expression, `lifecycle ${label}`, 15_000);
    t.diagnostic(`lifecycle completed ${label} at ${Date.now()-started}ms`);
  };
  try {
    const fixture = await startStreamingOnlyFixture({
      ortho: '/fixtures/orthophoto.tif',
      ept: '/fixtures/ept/ept.json',
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-view-mode-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await stage('orthophoto fallback selection', `location.search.includes('view=ortho') && document.querySelector('#tab-ortho')?.classList.contains('active')`);
    await stage('orthophoto raster rendered', `(() => {const image=document.querySelector('.leaflet-image-layer');
      return image?.complete && image.naturalWidth>0 && getComputedStyle(document.querySelector('#error-panel')).display==='none';})()`);
    assert.ok(fixture.requests.includes('/fixtures/orthophoto.tif'), 'raster fixture was not requested');

    await client.evaluate(`document.querySelector('#tab-cloud').click()`);
    await stage('point-cloud iframe start', `location.search.includes('view=cloud') && Boolean(document.querySelector('#pc-iframe'))`);
    await client.evaluate(`document.querySelector('#tab-ortho').click()`);
    await stage('point-cloud iframe teardown', `location.search.includes('view=ortho') && !document.querySelector('#pc-iframe')`);

    await client.evaluate('history.back()');
    await stage('history restores point cloud', `location.search.includes('view=cloud') && Boolean(document.querySelector('#pc-iframe'))`);
    await client.command('Page.reload');
    await stage('refresh preserves point cloud', `location.search.includes('view=cloud') && document.querySelector('#tab-cloud')?.classList.contains('active') && Boolean(document.querySelector('#pc-iframe'))`);

    assert.equal(fixture.requests.filter((requestPath) => requestPath === fixture.glbPath).length, 0, 'view lifecycle fetched the original GLB');
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

test('browser decodes Obj2Tiles KTX2 B3DM textures under the production CSP without unsafe-eval', { timeout: 90_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for KTX2 browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const csp = productionCspHeader();
    assert.ok(existsSync(path.join(root, 'dist/index.html')), 'Build the production viewer before this browser test');
    assert.deepEqual(readFileSync(path.join(root, 'dist/basis/basis_transcoder.js')),
      readFileSync(path.join(root, 'public/basis/basis_transcoder.js')), 'Rebuild stale production Basis assets');
    const fixture = await startFixture(path.join(root, 'test', 'fixtures', 'ktx2-tiles'), {
      contentSecurityPolicy: csp, productionBuild: true,
    });
    ({ server, vite } = fixture);
    assert.equal((await fetch(fixture.origin)).headers.get('content-security-policy'), csp);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-ktx2-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1440, screenHeight: 900,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model` });
    try { await waitFor(client, `(() => {
      const tiles = window.__ltds?.tiles?.();
      if (!tiles?.root || !tiles.group.children.length) return false;
      let maps = 0;
      tiles.group.traverse(object => {
        const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
        for (const material of materials) if (material.map?.image) maps += 1;
      });
      return maps > 0;
    })()`, 'KTX2 tile texture did not decode and attach', 60_000); } catch (error) {
      const runtime = await client.evaluate(`({
        status: document.querySelector('#lod-status')?.textContent,
        diagnostics: window.__ltds?.lodDiagnostics?.(),
        root: Boolean(window.__ltds?.tiles?.()?.root),
        groupChildren: window.__ltds?.tiles?.()?.group?.children?.length,
      })`);
      const errors = client.events.filter(event => event.method === 'Log.entryAdded'
        || event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled').slice(-20);
      throw new Error(`${error.message}; runtime=${JSON.stringify(runtime)}; events=${JSON.stringify(errors)}`);
    }

    const state = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const maps = [];
      tiles.group.traverse(object => {
        const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
        for (const material of materials) if (material.map) maps.push({
          compressed: Boolean(material.map.isCompressedTexture),
          format: material.map.format,
          mipCount: material.map.mipmaps?.length || 0,
          width: material.map.image?.width || 0,
          height: material.map.image?.height || 0,
        });
      });
      return {
        maps,
        errorPanel: getComputedStyle(document.querySelector('#error-panel')).display,
        cacheBytes: tiles.lruCache.cachedBytes,
      };
    })()`);
    assert.equal(state.errorPanel, 'none');
    assert.ok(state.maps.length > 0, JSON.stringify(state));
    assert.equal(state.maps.every(map => map.compressed && map.width > 0 && map.height > 0), true, JSON.stringify(state));
    assert.ok(state.maps.every(map => map.format > 1000 && map.format !== 1023 && map.mipCount > 0),
      'KTX2 must reach a real compressed GPU format, not uncompressed RGBA fallback: ' + JSON.stringify(state));
    assert.ok(state.cacheBytes > 0, JSON.stringify(state));
    assert.ok(fixture.requests.includes('/basis/basis_transcoder.js'), 'Viewer must request the installed CSP-safe glue');
    assert.ok(fixture.requests.includes('/basis/basis_transcoder.wasm'), 'Viewer must request the paired pinned WASM');
    const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
      && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
    assert.deepEqual(exceptions, []);
    const cspFailures = client.events.filter(event => event.method === 'Log.entryAdded'
      && /content security policy|unsafe-eval|EvalError/i.test(event.params.entry?.text || ''));
    assert.deepEqual(cspFailures, [], 'Production CSP must not block decoder workers');
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});
