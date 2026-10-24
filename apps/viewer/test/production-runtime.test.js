'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

// Early feedback for the tests-only runtime mount. This deliberately checks
// literal relative imports, not arbitrary JS; the exact image run is decisive.
function runtimeTestImportGuard({ sourceOverrides = new Map() } = {}) {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.match(runtime, / AS runtime\b/);
  const shipped = [{ target: 'test', directory: true }];
  for (const line of runtime.split(/\r?\n/)) {
    if (!line.startsWith('COPY ') || line.startsWith('COPY --from=')) continue;
    const parts = line.slice(5).trim().split(/\s+/), destination = parts.pop();
    for (const source of parts) {
      const directory = fs.statSync(path.join(repositoryRoot, source)).isDirectory();
      const target = path.posix.normalize(destination.endsWith('/') && !directory ? destination + path.posix.basename(source) : destination).replace(/^\.\//, '');
      shipped.push({ target, directory });
    }
  }
  const workflow = fs.readFileSync(path.resolve(repositoryRoot, '../../.github/workflows/publish-viewer.yml'), 'utf8');
  const mounted = workflow.match(/-v "\$PWD\/test:\/app\/test:ro" "\$VERIFY_IMAGE" --test\s*\\\r?\n((?:[ \t]+test\/[^\r\n]+\r?\n)+)/);
  assert.ok(mounted, 'exact-image tests-only verification block must remain discoverable');
  const entries = [...mounted[1].matchAll(/test\/[\w./-]+\.test\.(?:mjs|js)/g)].map(match => match[0]);
  assert.ok(entries.length > 0, 'the exact-image gate must include runtime test entries');
  const visited = new Set();
  function inspect(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = sourceOverrides.get(file) ?? fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(shipped.some(item => target === item.target || (item.directory && target.startsWith(item.target + '/'))),
        `${file} imports ${match[1]}, which is not copied into the final runtime or mounted test tree; move source-only integration to a separate test`);
      if (target.startsWith('test/')) {
        const resolved = [target, target + '.js', target + '.mjs'].find(candidate => fs.existsSync(path.join(repositoryRoot, candidate)) && /\.(?:mjs|js)$/.test(candidate));
        assert.ok(resolved, `${file}: cannot resolve mounted test dependency ${match[1]}`);
        inspect(resolved);
      }
    }
  }
  entries.forEach(inspect);
}

test('exact-image test entrypoints import only final-runtime modules or mounted test helpers', () => {
  runtimeTestImportGuard();
});

test('runtime import guard rejects raw frontend integration while allowing copied numerical modules', () => {
  const entry = 'test/measurement-calculation-jobs.test.js';
  const source = fs.readFileSync(path.join(repositoryRoot, entry), 'utf8');
  for (const injected of ["import('../measurement-store.mjs')", "require('../measurement-store.mjs')", "import {createMeasurementStore} from '../measurement-store.mjs'"]) {
    assert.throws(() => runtimeTestImportGuard({ sourceOverrides: new Map([[entry, source + '\n' + injected]]) }), /measurement-store\.mjs.*not copied/);
  }
  assert.doesNotThrow(() => runtimeTestImportGuard({ sourceOverrides: new Map([[entry, source + "\nimport('../measurement-volume.mjs')"]]) }));
});

test('production image pins the mesh converter and enforces the Potree 1.8.2 EPT constructor contract', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /ARG OBJ2TILES_VERSION=1\.6\.2/);
  assert.match(dockerfile, /OBJ2TILES_SOURCE_SHA256=79093e12f6eab2cfcd522aebe670892c5d8874e160956b84f3e55c77b94ac0b5/);
  assert.match(dockerfile, /OBJ2TILES_PATCH_SHA256=6d5d99ea1d1e36208e44d0456d35cb0d8c68092dfd4a6ad01288bf85bb67322b/);
  assert.match(dockerfile, /codeload\.github\.com\/OpenDroneMap\/Obj2Tiles\/tar\.gz\/refs\/tags\/v\$\{OBJ2TILES_VERSION\}/);
  assert.match(dockerfile, /sha256sum -c -[\s\S]*git apply --check \/tmp\/obj2tiles\.patch[\s\S]*git apply \/tmp\/obj2tiles\.patch/);
  assert.match(dockerfile, /dotnet publish[\s\S]*--self-contained true/);
  assert.match(dockerfile, /COPY third_party\/obj2tiles\/locks \/tmp\/obj2tiles-locks/);
  assert.match(dockerfile, /dotnet restore Obj2Tiles\/Obj2Tiles\.csproj --locked-mode -r "\$rid"/);
  assert.match(dockerfile, /dotnet publish[\s\S]*--no-restore/);
  assert.doesNotMatch(dockerfile, /PublishTrimmed=true/);
  assert.match(dockerfile, /build-info\.json/);
  assert.match(dockerfile, /COPY --from=obj2tiles \/opt\/obj2tiles \/opt\/obj2tiles/);
  assert.match(dockerfile, /COPY lod-policy\.mjs lod-memory-profile\.mjs \.\//,
    'the runtime image must include every server-side LOD policy dependency');
  assert.match(dockerfile, /node scripts\/patch-potree-ept\.mjs public\/potree\/build\/potree\/potree\.js/);
  const potreePatch = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'patch-potree-ept.mjs'), 'utf8');
  assert.match(potreePatch, /sharedNode='new Potree\.PointCloudCopcGeometryNode\(geometry\)'/);
  assert.match(potreePatch, /nonexistentNode='new Potree\.PointCloudEptGeometryNode\(geometry\)'/);
  assert.match(potreePatch, /block\.replace\(nonexistentNode,sharedNode\)/);
  const worker = fs.readFileSync(path.join(repositoryRoot, 'server', 'derivativeWorker.js'), 'utf8');
});

test('published image executes a real Obj2Tiles conversion and provenance audit', () => {
  const smokePath = path.join(repositoryRoot, 'scripts', 'verify-obj2tiles-runtime.mjs');
  assert.equal(fs.existsSync(smokePath), true, 'the immutable image includes a real converter smoke test');
  const smoke = fs.readFileSync(smokePath, 'utf8');
  const workflow = fs.readFileSync(path.resolve(repositoryRoot, '../../.github/workflows/publish-viewer.yml'), 'utf8');
  assert.match(smoke, /spawnSync\(obj2Tiles/);
  assert.match(smoke, /auditControlledObj2Tiles/);
  assert.match(smoke, /lod-provenance\.json/);
  assert.match(smoke, /KHR_texture_basisu/);
  assert.match(smoke, /compressedTextures/);
  assert.match(workflow, /docker run --rm "\$VERIFY_IMAGE" node scripts\/verify-obj2tiles-runtime\.mjs/);
  const schemaVersion = require('../server/database').MIGRATIONS.at(-1).version;
  const expectedVersions = [...workflow.matchAll(/EXPECTED_SCHEMA_VERSION: "(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(expectedVersions, [schemaVersion, schemaVersion], 'verification and attestation must both match the current database schema');
});

test('exact-image point-cloud gate verifies installed visibility and demand bytes without source repair',()=>{
  const workflow=fs.readFileSync(path.resolve(repositoryRoot,'../../.github/workflows/publish-viewer.yml'),'utf8');
  assert.match(workflow,/-e POTREE_BUNDLE=\/app\/dist\/potree\/build\/potree\/potree\.js[\s\S]*?-v "\$PWD\/test:\/app\/test:ro" "\$VERIFY_IMAGE" --test\s*\\\r?\n\s*test\/potree-visibility-patch\.test\.mjs/);
  assert.match(workflow,/"\$VERIFY_IMAGE" node scripts\/verify-potree-visibility\.mjs \/app\/dist\/potree\/build\/potree\/potree\.js/);
  const verifier=fs.readFileSync(path.join(repositoryRoot,'scripts/verify-potree-visibility.mjs'),'utf8');
  assert.match(verifier,/patchPotreeVisibilitySelection\(source\)===source/);
  assert.doesNotMatch(verifier,/writeFile|renameSync/);
});

test('production Compose publishes only the gated Viewer API on the approved TrueNAS layout', () => {
  const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
  const environmentTemplate = fs.readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');
  const externalNginx = fs.readFileSync(path.join(repositoryRoot, 'deploy', 'nginx-viewer.conf.example'), 'utf8');
  const updateScript = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'update-truenas.sh'), 'utf8');
  const storageScript = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'truenas-storage.sh'), 'utf8');
  const processingRunbook = fs.readFileSync(path.join(repositoryRoot, 'docs', 'PROCESSING_PLATFORM.md'), 'utf8');
  const indexSource = fs.readFileSync(path.join(repositoryRoot, 'server', 'index.js'), 'utf8');

  assert.match(compose, /\$\{VIEWER_BIND_ADDRESS:-192\.168\.50\.80\}:\$\{VIEWER_PORT:-8088\}:8088/);
  assert.match(compose, /PORT:\s*8088/);
  assert.match(compose, /PROCESSING_PLATFORM_ENABLED:\s*\$\{PROCESSING_PLATFORM_ENABLED:-true\}/);
  assert.doesNotMatch(compose, /profiles:\s*\[processing\]/);
  assert.match(compose, /env_file:[\s\S]*VIEWER_ENV_FILE:-\/mnt\/Plugins\/App_Data\/Model-Viewer\/Config\/viewer\.env/);
  assert.match(compose, /X_ACCEL_REDIRECT_PREFIX:\s*""/);
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.match(compose, /image:\s*ghcr\.io\/ledgetoptechnologies\/ledgetop-ops-viewer:latest/);
  assert.doesNotMatch(compose, /\$\{VIEWER_IMAGE/);
  assert.match(compose, /pull_policy:\s*always/);
  assert.match(compose, /stop_grace_period:\s*2m/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\[ALL\]/);
  assert.doesNotMatch(compose, /cap_add:/);
  assert.match(compose, /user:\s*"568:568"/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /pids_limit:\s*256/);
  assert.match(compose, /\/tmp:rw,noexec,nosuid,nodev,size=256m/);
  assert.match(compose, /max-size:\s*10m/);
  assert.match(compose, /max-file:\s*"3"/);
  assert.match(compose, /\/mnt\/Plugins\/App_Data\/WebODM\/Media:\/imports\/webodm:ro/);
  assert.match(compose, /source:\s*\/mnt\/Plugins\/App_Data\/Model-Viewer\/Storage[\s\S]*target:\s*\/app\/storage[\s\S]*create_host_path:\s*false/);
  assert.doesNotMatch(compose, /viewer_storage|ltds-viewer-storage/);
  assert.doesNotMatch(compose, /DERIVATIVES_MOUNT|legacy-derivatives|Model-Viewer\/Derivatives/);
  assert.match(compose, /DATA_DIR:\s*\/app\/storage\/data/);
  assert.match(compose, /DATABASE_PATH:\s*\/app\/storage\/data\/viewer\.sqlite/);
  assert.match(compose, /DATASETS_MOUNT:\s*\/app\/storage\/datasets/);
  assert.match(compose, /MODELS_MOUNT:\s*\/app\/storage\/models/);
  assert.match(compose, /TRASH_MOUNT:\s*\/app\/storage\/trash/);
  assert.match(compose, /EMERGENCY_ADMIN_ENABLED:\s+"false"/);
  assert.match(compose, /LOCAL_DERIVATIVES_ENABLED:\s+"false"/);
  assert.match(compose, /MESH_DERIVATIVES_ENABLED:\s+\$\{MESH_DERIVATIVES_ENABLED:-true\}/);
  assert.match(compose, /OBJ2TILES_BIN:\s+\/opt\/obj2tiles\/Obj2Tiles/);
  assert.match(compose, /viewer-worker:[\s\S]*processing_worker_heartbeat/);
  assert.doesNotMatch(compose, /viewer-worker:[\s\S]*healthcheck:\s*\{disable:\s*true\}/);
  assert.doesNotMatch(compose, /^\s{2}gateway:/m);
  assert.match(compose, /viewer-api:[\s\S]*?ports:\s*\["\$\{VIEWER_BIND_ADDRESS:-192\.168\.50\.80\}:\$\{VIEWER_PORT:-8088\}:8088"\]/);
  assert.match(compose, /test:\s*\[CMD, node, scripts\/container-healthcheck\.js\]/);
  assert.doesNotMatch(compose, /ADMIN_PASSWORD:/);
  assert.doesNotMatch(compose, /SERVICE_AUTH_SECRET:|SESSION_SECRET:|VIEWER_EVENT_SECRET:|PROXY_SHARED_SECRET:/);
  assert.match(environmentTemplate, /^PROXY_SHARED_SECRET=\s*$/m);
  assert.match(environmentTemplate, /TRUST_PROXY_HOPS=1/);
  assert.match(externalNginx, /# proxy_set_header X-Viewer-Proxy-Secret \$viewer_proxy_secret/);
  assert.doesNotMatch(externalNginx.slice(externalNginx.indexOf('    location ')), /proxy_set_header/);
  assert.match(externalNginx, /proxy_set_header X-Forwarded-For \$remote_addr/);
  assert.match(externalNginx, /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(externalNginx, /proxy_force_ranges on/);
  assert.match(externalNginx, /proxy_cache off/);
  assert.match(externalNginx, /limit_req zone=viewer_share/);
  assert.match(updateScript, /--env-file "\$viewer_config"/);
  assert.match(updateScript, /PROCESSING_PLATFORM_ENABLED/);
  assert.match(updateScript, /:sha-/);
  assert.match(updateScript, /@sha256:/);
  assert.match(updateScript, /official_latest_image="ghcr\.io\/ledgetoptechnologies\/ledgetop-ops-viewer:latest"/);
  assert.match(updateScript, /"\$target_image" != "\$official_latest_image"/);
  assert.doesNotMatch(environmentTemplate, /^VIEWER_IMAGE=/m);
  assert.match(updateScript, /VIEWER_UPDATE_ALLOW_ACTIVE/);
  assert.match(updateScript, /--wait --wait-timeout 180/);
  assert.match(updateScript, /ltds-viewer-rollback:previous/);
  assert.match(updateScript, /docker inspect --format '\{\{\.Image\}\}' "\$api_id"/);
  assert.match(updateScript, /docker image tag "\$previous_image_id" "\$rollback_image"/);
  assert.match(updateScript, /rollback_compose="\$compose_dir\/scripts\/docker-compose\.rollback\.yml"/);
  assert.match(updateScript, /VIEWER_ROLLBACK_IMAGE="\$rollback_image"[\s\S]*-f "\$rollback_compose"[\s\S]*--pull never/);
  assert.match(updateScript, /production-readiness\.mjs/);
  assert.match(updateScript, /readiness_args=\(\)/);
  assert.match(updateScript, /mode" == processing.*readiness_args\+=\(--require-processing\)/);
  assert(updateScript.indexOf(' pull || rollback pull') < updateScript.indexOf('active durable work exists'));
  assert.match(updateScript, /keep Ops admission paused/);
  assert.match(indexSource, /server\.close\(\(error\) =>/);
  assert.match(storageScript, /storage_path=\/mnt\/Plugins\/App_Data\/Model-Viewer\/Storage/);
  assert.match(storageScript, /\.ltds-viewer-storage-root/);
  assert.match(storageScript, /readlink -f/);
  assert.match(storageScript, /! -name \.ltds-viewer-storage-root/);
  assert.doesNotMatch(storageScript, /docker volume/);
  assert.match(storageScript, /--user 568:568/);
  assert.match(storageScript, /CONFIRM_UID_568/);
  assert.match(storageScript, /CONFIRM_RESTORE/);
  assert.match(storageScript, /sha256sum -c/);
  assert.match(updateScript, /storage_path=\/mnt\/Plugins\/App_Data\/Model-Viewer\/Storage/);
  assert.match(updateScript, /expected 568:568/);
  assert.match(updateScript, /never creates, moves, deletes, or chowns storage/);
  assert.doesNotMatch(updateScript, /(^|\s)(?:mkdir|install|chown)(?:\s|$)/m);
  assert.doesNotMatch(fs.readFileSync(path.join(repositoryRoot, 'scripts', 'production-readiness.mjs'), 'utf8'), /DERIVATIVES_MOUNT is required/);
  assert.match(processingRunbook, /Copy-first migration from the former named volume/);
  assert.match(processingRunbook, /Do not use `mv`, do not remove the old named volume/);
  assert.match(processingRunbook, /\.ltds-viewer-storage-root/);
  assert.doesNotMatch(processingRunbook, /--profile processing/);
});

test('runtime image is rootless as the TrueNAS Apps service identity', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /groupmod --gid 568 node/);
  assert.match(dockerfile, /usermod --uid 568 --gid 568 node/);
  assert.match(dockerfile, /chown -R 568:568 \/app\/storage/);
  assert.match(dockerfile, /USER 568:568/);
  assert.doesNotMatch(dockerfile, /ENTRYPOINT|USER root/);
});

test('release-candidate image tags cannot move latest', () => {
  const workflow = fs.readFileSync(path.resolve(repositoryRoot, '../../.github/workflows/publish-viewer.yml'), 'utf8');
  const buildStart = workflow.indexOf('- name: Build isolated candidate');
  const verifyStart = workflow.indexOf('- name: Verify exact candidate image');
  const promoteStart = workflow.indexOf('- name: Promote verified digest to release tags');
  const buildBlock = workflow.slice(buildStart, verifyStart);
  const verifyBlock = workflow.slice(verifyStart, promoteStart);

  assert.match(workflow, /flavor:\s*\|\s*latest=false/);
  assert.match(workflow, /type=raw,value=latest,enable=\$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(workflow, /type=ref,event=tag/);
  assert.match(workflow, /type=sha,prefix=sha-/);
  assert.ok(buildStart >= 0 && buildStart < verifyStart && verifyStart < promoteStart);
  assert.match(workflow, /candidate-\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(buildBlock, /push: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(buildBlock, /load: \$\{\{ github\.event_name != 'push' \|\| github\.ref != 'refs\/heads\/main' \}\}/);
  assert.match(buildBlock, /tags: \$\{\{ steps\.candidate\.outputs\.ref \}\}/);
  assert.match(buildBlock, /provenance: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(buildBlock, /sbom: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.doesNotMatch(buildBlock, /steps\.meta\.outputs\.tags/);
  assert.doesNotMatch(verifyBlock, /if: github\.event_name == 'push'/);
  assert.match(workflow, /\[\[ "\$IMAGE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(workflow, /\[\[ "\$EXPECTED_REVISION" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(verifyBlock, /docker image inspect "\$VERIFY_IMAGE"/);
  assert.match(verifyBlock, /CANDIDATE_DIGEST=.*imagetools inspect "\$CANDIDATE_IMAGE"[\s\S]*test "\$CANDIDATE_DIGEST" = "\$IMAGE_DIGEST"/);
  assert.match(verifyBlock, /docker pull "\$VERIFY_IMAGE"/);
  assert.match(workflow, /FINAL_TAGS: \$\{\{ steps\.meta\.outputs\.tags \}\}/);
  assert.match(workflow, /imagetools create --tag "\$tag" "\$PUBLISHED_IMAGE"/);
  assert.match(workflow, /PROMOTED_DIGEST=.*imagetools inspect "\$tag"[\s\S]*test "\$PROMOTED_DIGEST" = "\$IMAGE_DIGEST"/);
  assert.match(workflow, /\.Config\.User[\s\S]*568:568/);
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(workflow, /source-commit\.txt[\s\S]*stat -c %a[\s\S]*444/);
  assert.match(workflow, /Obj2Tiles --version[\s\S]*EXPECTED_OBJ2TILES_VERSION/);
  assert.match(workflow, /const shared="new Potree\.PointCloudCopcGeometryNode\(geometry\)"/);
  assert.match(workflow, /source\.includes\(nonexistent\)[\s\S]*source\.slice\(end\)\.includes\(shared\)/);
  assert.match(workflow, /EptLazRsDecoderWorker\.js[\s\S]*EPT LAZ-RS decode failed/);
  assert.match(workflow, /laz_rs_wasm_bg-.*\\\.wasm/);
  assert.match(workflow, /wasm\.length!==1[\s\S]*size<1000/);
  assert.match(workflow, /const relativeWasmReference=/);
  assert.match(workflow, /const route=source\.indexOf\("isFullFile \?"\)[\s\S]*const lazRs=source\.indexOf\("EptLazRsDecoderWorker\.js",route\)[\s\S]*const legacy=source\.indexOf\("EptLaszipDecoderWorker\.js",route\)/);
  assert.match(workflow, /const moduleFactory="url\.endsWith\(\\"\/EptLazRsDecoderWorker\.js\\"\) \? \{type: \\"module\\"\} : undefined"/);
  assert.match(workflow, /e\.data\.pointCount/);
  assert.match(workflow, /SELECT MAX\(version\) AS version FROM schema_migrations/);
  assert.match(workflow, /test "\$VIEWER_SCHEMA_VERSION" = "\$EXPECTED_SCHEMA_VERSION"/);
  assert.match(workflow, /node scripts\/write-image-attestation\.mjs viewer-image-attestation\.json/);
  assert.match(workflow, /sha256sum viewer-image-attestation\.json > viewer-image-attestation\.json\.sha256/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v6[\s\S]*viewer-image-attestation-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /if-no-files-found:\s*error/);
});

test('live ODM compatibility cancellation exercises committed work and waits for status 50', () => {
  const harness = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'verify-odm-provider.mjs'), 'utf8');
  const initialize = harness.indexOf('provider.initialize({ uuid:cancelUuid');
  const upload = harness.indexOf('provider.upload(cancelUuid, corpus.files', initialize);
  const commit = harness.indexOf('provider.commit(cancelUuid,', upload);
  const cancel = harness.indexOf('provider.cancel(cancelUuid,', commit);

  assert(initialize >= 0 && initialize < upload && upload < commit && commit < cancel);
  assert.match(harness, /\['queued_upstream', 'running'\]\.includes\(status\.status\)/);
  assert.match(harness, /cancelStatus\.status === 'cancelled'/);
  assert.match(harness, /removeAndVerify\(provider, cancelUuid/);
});

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(url, child, init = {}) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const response = await httpRequest(url, init.headers || {});
      lastStatus = response.status;
      if (response.ok) return response;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`viewer did not become ready (last HTTP ${lastStatus})`);
}

function httpRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: new Headers(response.headers),
          async json() { return JSON.parse(body); },
          async text() { return body; },
        });
      });
    });
    request.once('error', reject);
  });
}

function requestWithHost(port, host, requestPath = '/', proxySecret = null) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (proxySecret) headers['X-Viewer-Proxy-Secret'] = proxySecret;
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, location: response.headers.location || null }));
    });
    request.once('error', reject);
  });
}

test('production gates health/readiness and all routes behind exact proxy host and secret', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-production-'));
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');

  const port = await unusedPort();
  const proxySecret = 'test-proxy-secret-0000000000000000000000000';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: root,
      DIST_DIR: distDir,
      PUBLIC_BASE_URL: 'https://viewer.example.test',
      EXPECTED_HOST: 'viewer.example.test',
      ALLOWED_EMBED_ORIGINS: 'https://ops.example.test,https://client.example.test',
      OPS_BASE_URL: 'https://ops.example.test',
      WEBODM_ENABLED: 'false',
      SYNC_ON_STARTUP: 'false',
      EMERGENCY_ADMIN_ENABLED: 'false',
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      SERVICE_AUTH_SECRET: 'test-service-secret-that-is-at-least-32-characters',
      PROXY_SHARED_SECRET: proxySecret,
      TRUSTED_PROXY_ADDRESSES: '127.0.0.1/32',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const proxyHeaders = { Host: 'viewer.example.test', 'X-Viewer-Proxy-Secret': proxySecret };
  const ready = await waitFor(`${baseUrl}/api/v1/ready`, child, { headers: proxyHeaders });
  assert.deepEqual(await ready.json(), { ok: true, missing: [] });
  assert.equal(ready.headers.get('x-ltds-viewer-revision'), 'unavailable');
  assert.equal(ready.headers.get('x-ltds-viewer-schema-version'), '40');
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.equal((await httpRequest(`${baseUrl}/api/v1/health`)).status, 421);
  assert.equal((await httpRequest(`${baseUrl}/api/v1/health`, { Host: 'viewer.example.test' })).status, 403);
  const rejected = await httpRequest(`${baseUrl}/api/v1/health`, { Host: 'viewer.example.test', 'X-Viewer-Proxy-Secret': `${proxySecret}x` });
  assert.equal(rejected.status, 403);
  assert.doesNotMatch(await rejected.text(), /test-proxy-secret/);
  const health = await httpRequest(`${baseUrl}/api/v1/health`, proxyHeaders);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('x-ltds-viewer-revision'), 'unavailable');
  assert.equal(health.headers.get('x-ltds-viewer-schema-version'), '40');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const contentSecurityPolicy = health.headers.get('content-security-policy') || '';
  assert.match(
    contentSecurityPolicy,
    /frame-ancestors 'self' https:\/\/ops\.example\.test https:\/\/client\.example\.test/,
  );
  assert.match(contentSecurityPolicy, /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.match(contentSecurityPolicy, /connect-src 'self' blob: https:\/\/server\.arcgisonline\.com/);
  assert.doesNotMatch(contentSecurityPolicy.split(';').find(value => value.trim().startsWith('connect-src')), /ops\.example\.test/);
  for (const pathname of ['/workspace', '/workspace/test-grant', '/workspace.html']) {
    const workspaceResponse = await httpRequest(`${baseUrl}${pathname}`, proxyHeaders);
    const connect = workspaceResponse.headers.get('content-security-policy').split(';').find(value => value.trim().startsWith('connect-src'));
    assert.equal(connect.trim(), "connect-src 'self' blob: https://server.arcgisonline.com https://ops.example.test");
    assert.doesNotMatch(connect, /client\.example\.test|\*/);
  }
  assert.doesNotMatch(contentSecurityPolicy, /(?:^|[ ;])'unsafe-eval'(?:[ ;]|$)/);
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  assert.equal((await requestWithHost(port, 'attacker.example.test', '/', proxySecret)).status, 421);
  assert.deepEqual(await requestWithHost(port, 'viewer.example.test', '/', proxySecret), {
    status: 302,
    location: 'https://ops.example.test',
  });
  assert.deepEqual(await requestWithHost(port, 'viewer.example.test', '/admin-login.html', proxySecret), {
    status: 302,
    location: 'https://ops.example.test',
  });
  assert.equal((await requestWithHost(port, 'viewer.example.test', '/api/admin/session', proxySecret)).status, 404);
});
