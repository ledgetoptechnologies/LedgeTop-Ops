'use strict';

// Arithmetic only. This module neither reserves space nor verifies quotas,
// writer quiescence, filesystem identity, or the completeness of a ledger.
// It must not be used as an admission gate until those contracts are wired.
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function invalid() { return Object.assign(new Error('capacity budget inputs are unavailable or invalid'), {code:'capacity_budget_invalid'}); }
function scalar(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return BigInt(value);
}
function identity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw invalid();
  return value;
}
function bounded(value) { if (value > MAX) throw invalid(); return Number(value); }
function positiveDifference(value, reserve) { return value > reserve ? value-reserve : 0n; }

function evaluateCapacityBudget({domainId,domainRevision,samples,commitments,requestBytes,requestInodes}) {
  identity(domainId); identity(domainRevision);
  if (!Array.isArray(samples) || !samples.length || !Array.isArray(commitments)) throw invalid();
  const requestedBytes=scalar(requestBytes),requestedInodes=scalar(requestInodes);
  let usableBytes=null,usableInodes=null;
  for (const sample of samples) {
    if (!sample || sample.domainId!==domainId || sample.domainRevision!==domainRevision) throw invalid();
    const bytes=positiveDifference(scalar(sample.availableBytes),scalar(sample.reserveBytes));
    const inodes=positiveDifference(scalar(sample.availableInodes),scalar(sample.reserveInodes));
    usableBytes=usableBytes===null||bytes<usableBytes?bytes:usableBytes;
    usableInodes=usableInodes===null||inodes<usableInodes?inodes:usableInodes;
  }
  let committedBytes=0n,committedInodes=0n;
  const seen=new Set();
  for (const item of commitments) {
    if (!item || item.domainId!==domainId || item.domainRevision!==domainRevision || typeof item.id!=='string' || !item.id || seen.has(item.id)) throw invalid();
    seen.add(item.id); committedBytes+=scalar(item.remainingBytes); committedInodes+=scalar(item.remainingInodes);
  }
  const requiredBytes=committedBytes+requestedBytes,requiredInodes=committedInodes+requestedInodes;
  return {
    allowed:requiredBytes<=usableBytes && requiredInodes<=usableInodes,
    usableBytes:bounded(usableBytes),usableInodes:bounded(usableInodes),
    committedBytes:bounded(committedBytes),committedInodes:bounded(committedInodes),
    requiredBytes:bounded(requiredBytes),requiredInodes:bounded(requiredInodes),
  };
}

module.exports={evaluateCapacityBudget};
