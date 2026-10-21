import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOD_MEMORY_MODE,
  evaluateLodMemoryAdmission,
  isLodMemoryMode,
  LOD_MEMORY_MODES,
  normalizeLodMemoryMode,
  parseLodMemoryMode,
  resolveLodMemoryProfile,
  serializeLodMemoryMode,
} from '../lod-memory-profile.mjs';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

test('memory modes expose only stable user choices and persist only the key', () => {
  assert.deepEqual(LOD_MEMORY_MODES, ['auto', 'balanced', 'high']);
  assert.equal(DEFAULT_LOD_MEMORY_MODE, 'auto');
  for (const mode of LOD_MEMORY_MODES) {
    assert.equal(isLodMemoryMode(mode), true);
    assert.equal(serializeLodMemoryMode(mode), mode);
    assert.equal(parseLodMemoryMode(serializeLodMemoryMode(mode)), mode);
  }

  assert.equal(normalizeLodMemoryMode('High'), 'auto');
  assert.equal(parseLodMemoryMode('{"mode":"high","cacheHardBytes":999999999999}'), 'auto');
  assert.equal(serializeLodMemoryMode({ mode: 'high' }), 'auto');
  assert.equal(isLodMemoryMode('conservative'), false);
});

test('Auto uses a coarse browser hint without treating it as system RAM', () => {
  const missing = resolveLodMemoryProfile();
  assert.equal(missing.mode, 'auto');
  assert.equal(missing.deviceClass, 'unknown');
  assert.equal(missing.policyKey, 'balanced', 'missing hints use the safe standard default');
  assert.equal(missing.cacheSoftBytes, 2.5 * GiB);
  assert.equal(missing.cacheHardBytes, 3.125 * GiB);

  const constrained = resolveLodMemoryProfile({ mode: 'auto', deviceMemoryGiB: 4 });
  assert.equal(constrained.deviceClass, 'constrained');
  assert.equal(constrained.policyKey, 'constrained');
  assert.equal(constrained.cacheSoftBytes, 768 * MiB);
  assert.equal(constrained.cacheHardBytes, 1 * GiB);
  assert.equal(constrained.downloadConcurrency, 4);
  assert.equal(constrained.parseConcurrency, 1);

  const roomy = resolveLodMemoryProfile({ mode: 'auto', deviceMemoryGiB: 8 });
  assert.equal(roomy.deviceClass, 'roomy');
  assert.equal(roomy.policyKey, 'roomy');
  assert.equal(roomy.cacheSoftBytes, 3 * GiB);
  assert.equal(roomy.cacheHardBytes, 3.75 * GiB);
  assert.equal(roomy.downloadConcurrency, 8);
  assert.equal(roomy.parseConcurrency, 2);

  assert.equal(resolveLodMemoryProfile({ deviceMemoryGiB: Number.NaN }).policyKey, 'balanced');
  assert.equal(resolveLodMemoryProfile({ deviceMemoryGiB: -1 }).policyKey, 'balanced');
  assert.equal(resolveLodMemoryProfile({ deviceMemoryGiB: 'not-a-number' }).policyKey, 'balanced');
});

test('explicit Balanced and High modes are predictable on capable or unknown desktops', () => {
  const balanced = resolveLodMemoryProfile({ mode: 'balanced', deviceMemoryGiB: 8 });
  assert.equal(balanced.policyKey, 'balanced');
  assert.equal(balanced.deviceClass, 'roomy');
  assert.equal(balanced.shellRetentionBytes, 512 * MiB);
  assert.equal(balanced.recentFrontierBytes, 384 * MiB);
  assert.equal(balanced.cacheOverflowBytes, 640 * MiB);
  assert.equal(balanced.downloadConcurrency, 6);
  assert.equal(balanced.parseConcurrency, 2);

  const high = resolveLodMemoryProfile({ mode: 'high' });
  assert.equal(high.policyKey, 'high');
  assert.equal(high.cacheSoftBytes, 4 * GiB);
  assert.equal(high.cacheHardBytes, 5 * GiB);
  assert.equal(high.cacheOverflowBytes, 1 * GiB);
  assert.equal(high.shellRetentionBytes, 768 * MiB);
  assert.equal(high.recentFrontierBytes, 768 * MiB);
  assert.equal(high.downloadConcurrency, 10);
  assert.equal(high.parseConcurrency, 3);
});

test('a known low-memory browser cannot be forced past the reduced safety profile', () => {
  for (const mode of LOD_MEMORY_MODES) {
    const profile = resolveLodMemoryProfile({ mode, deviceMemoryGiB: 4 });
    assert.equal(profile.mode, mode, 'the stable user preference remains selected');
    assert.equal(profile.policyKey, 'constrained');
    assert.equal(profile.cacheHardBytes, 1 * GiB);
    assert.equal(profile.downloadConcurrency, 4);
    assert.equal(profile.parseConcurrency, 1);
  }
});

test('every profile has a bounded overflow and bounded warm retention', () => {
  const profiles = [
    resolveLodMemoryProfile(),
    resolveLodMemoryProfile({ deviceMemoryGiB: 4 }),
    resolveLodMemoryProfile({ deviceMemoryGiB: 8 }),
    resolveLodMemoryProfile({ mode: 'balanced' }),
    resolveLodMemoryProfile({ mode: 'high' }),
  ];

  for (const profile of profiles) {
    assert.ok(profile.cacheSoftBytes > 0);
    assert.ok(profile.cacheHardBytes > profile.cacheSoftBytes);
    assert.equal(profile.cacheOverflowBytes, profile.cacheHardBytes - profile.cacheSoftBytes);
    assert.ok(profile.cacheHardBytes <= 5 * GiB, 'the absolute overflow bound is never open-ended');
    assert.ok(profile.shellRetentionBytes <= profile.cacheSoftBytes / 2);
    assert.ok(profile.recentFrontierBytes <= profile.cacheSoftBytes / 2);
    assert.ok(profile.shellRetentionBytes + profile.recentFrontierBytes < profile.cacheSoftBytes,
      'warm fallback cannot consume the full steady-state detail budget');
    assert.ok(profile.downloadConcurrency >= profile.parseConcurrency);
    assert.ok(profile.downloadConcurrency <= 10);
    assert.ok(profile.parseConcurrency <= 3);
  }
});

test('prospective admission includes incoming bytes and never crosses the hard cap', () => {
  const profile = resolveLodMemoryProfile({ mode: 'balanced' });
  assert.deepEqual(evaluateLodMemoryAdmission(profile, {
    residentBytes: 2 * GiB,
    incomingBytes: 256 * MiB,
  }), {
    state: 'normal',
    admit: true,
    projectedBytes: 2.25 * GiB,
    softBytes: 2.5 * GiB,
    hardBytes: 3.125 * GiB,
    overflowBytes: 0,
    bytesToFree: 0,
  });

  const overflow = evaluateLodMemoryAdmission(profile, {
    residentBytes: 2.5 * GiB,
    incomingBytes: 384 * MiB,
  });
  assert.equal(overflow.state, 'overflow');
  assert.equal(overflow.admit, true);
  assert.equal(overflow.projectedBytes, 2.875 * GiB);
  assert.equal(overflow.overflowBytes, 384 * MiB);
  assert.equal(overflow.bytesToFree, 0);

  const deferred = evaluateLodMemoryAdmission(profile, {
    residentBytes: 3 * GiB,
    incomingBytes: 256 * MiB,
  });
  assert.equal(deferred.state, 'defer');
  assert.equal(deferred.admit, false);
  assert.equal(deferred.projectedBytes, 3.25 * GiB);
  assert.equal(deferred.bytesToFree, 128 * MiB);

  const reclaimed = evaluateLodMemoryAdmission(profile, {
    residentBytes: 3 * GiB,
    incomingBytes: 256 * MiB,
    reclaimableBytes: 512 * MiB,
  });
  assert.equal(reclaimed.state, 'overflow');
  assert.equal(reclaimed.admit, true);
  assert.equal(reclaimed.projectedBytes, 2.75 * GiB);
});

test('admission sanitizes invalid telemetry and falls back to the safe profile', () => {
  const result = evaluateLodMemoryAdmission(null, {
    residentBytes: -1,
    incomingBytes: Number.NaN,
    reclaimableBytes: Infinity,
  });
  assert.equal(result.state, 'normal');
  assert.equal(result.projectedBytes, 0);
  assert.equal(result.softBytes, 2.5 * GiB);
  assert.equal(result.hardBytes, 3.125 * GiB);

  const cannotInventHeadroom = evaluateLodMemoryAdmission(
    resolveLodMemoryProfile({ mode: 'balanced' }),
    { residentBytes: 256 * MiB, incomingBytes: 3 * GiB, reclaimableBytes: 100 * GiB },
  );
  assert.equal(cannotInventHeadroom.projectedBytes, 3 * GiB);
  assert.equal(cannotInventHeadroom.state, 'overflow');
});
