import { safeMeasurementCalculationErrorCode } from './measurement-calculation-broker.mjs';

const CHANNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_PATTERN = CHANNEL_ID_PATTERN;
const RENEWAL_LEAD_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const CONTINUITY_KEY = 'ltds-viewer-model-controller-contexts-v1';
const MAX_CONTEXTS = 32;
const CONTEXT_RETENTION_MS = 24 * 60 * 60 * 1000;
const GRANT_ISSUANCE_TIMEOUT_MS = 10_000;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function validContext(value) {
  const mode = value?.sessionMode || 'review';
  const keys = mode === 'published' ? ['outputId', 'modelId', 'modelVersionId'] : ['attemptId', 'modelId', 'modelVersionId'];
  return value && ['review', 'published'].includes(mode) && keys.every(key => (
    typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200
  )) && (mode !== 'published' || value.outputId === value.modelVersionId)
    && Number.isInteger(value.sessionTtlSeconds) && value.sessionTtlSeconds >= 60 && value.sessionTtlSeconds <= 86_400;
}

function validIssuedGrant(result, context) {
  return result && result.sessionMode === (context.sessionMode || 'review')
    && ((context.sessionMode || 'review') !== 'review' || result.attemptId === context.attemptId)
    && result.modelId === context.modelId
    && result.modelVersionId === context.modelVersionId
    && result.sessionTtlSeconds === context.sessionTtlSeconds
    && GRANT_PATTERN.test(result.grant || '');
}

function validSessionExpiry(value, record, now, { afterCurrent = false } = {}) {
  const expiresAtMs = Date.parse(value || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return false;
  if (expiresAtMs > now + record.context.sessionTtlSeconds * 1000 + CLOCK_SKEW_MS) return false;
  if (afterCurrent && expiresAtMs <= record.expiresAtMs) return false;
  return true;
}

export class ReviewSessionController {
  constructor({
    origin,
    issueGrant,
    measurementRequest = null,
    createChannel = name => new BroadcastChannel(name),
    now = () => Date.now(),
    retryDelays = [2_000, 5_000, 15_000],
    setTimer = (handler, delay) => setTimeout(handler, delay),
    clearTimer = timer => clearTimeout(timer),
    storage = null,
  }) {
    if (typeof origin !== 'string' || !origin || new URL(origin).origin !== origin) throw new Error('invalid review controller origin');
    if (typeof issueGrant !== 'function' || typeof createChannel !== 'function') throw new Error('review channel dependencies are required');
    this.origin = origin;
    this.issueGrant = issueGrant;
    this.measurementRequest = measurementRequest;
    this.createChannel = createChannel;
    this.now = now;
    this.retryDelays = [...retryDelays].filter(delay => Number.isFinite(delay) && delay >= 0).slice(0, 3);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.records = new Map();
    this.storage = storage;
    this.subject = null;
  }

  // These descriptors are routing hints, never credentials. Restoration is
  // enabled only after the workspace server authenticates the same subject.
  setAuthenticatedSubject(subject) {
    if (typeof subject !== 'string' || !/^[A-Za-z0-9._:@-]{1,200}$/.test(subject)) return false;
    if (this.subject === subject) return true;
    this.suspend({ preserve: true });
    this.subject = subject;
    let saved;
    try {
      const text = this.storage?.getItem(CONTINUITY_KEY);
      if (text?.length > 32_768) throw new Error('oversized continuity data');
      saved = text ? JSON.parse(text) : null;
    } catch { saved = null; }
    const now = this.now();
    if (exactKeys(saved, ['subject','records']) && saved.subject === subject
      && Array.isArray(saved.records) && saved.records.length <= MAX_CONTEXTS) {
      for (const item of saved.records) {
        const context = item?.context;
        const contextKeys = context?.sessionMode === 'published'
          ? ['sessionMode','outputId','modelId','modelVersionId','sessionTtlSeconds']
          : ['attemptId','modelId','modelVersionId','sessionTtlSeconds'];
        if (!exactKeys(item, ['channelId','context','updatedAt']) || !exactKeys(context, contextKeys)
          || !Number.isFinite(item.updatedAt) || now - item.updatedAt < 0 || now - item.updatedAt > CONTEXT_RETENTION_MS) continue;
        if (this.track(item.channelId, context, { restoring: true })) {
          this.records.get(item.channelId).updatedAt = item.updatedAt;
        }
      }
    }
    this.persistContexts();
    for (const record of this.records.values()) {
      try {
        record.channel.postMessage({ version: 1, type: 'ltds-viewer:controller-ready',
          channelId: record.channelId, modelId: record.context.modelId });
      } catch { this.untrack(record.channelId); }
    }
    return true;
  }

  persistContexts() {
    if (!this.storage || !this.subject) return;
    try {
      this.storage.setItem(CONTINUITY_KEY, JSON.stringify({ subject: this.subject,
        records: [...this.records.values()].slice(-MAX_CONTEXTS).map(record => ({
          channelId: record.channelId, context: record.context, updatedAt: record.updatedAt,
        })),
      }));
    } catch {
      // A failed write must not leave a previously revoked/untracked descriptor
      // eligible for restoration. Storage denial still cannot grant authority.
      try { this.storage.removeItem(CONTINUITY_KEY); } catch {}
    }
  }

  suspend({ preserve = false } = {}) {
    if (preserve && this.records.size) this.persistContexts();
    for (const channelId of [...this.records.keys()]) this.untrack(channelId, { persist: false });
    this.subject = null;
    if (!preserve) try { this.storage?.removeItem(CONTINUITY_KEY); } catch {}
  }

  track(channelId, context, { restoring = false } = {}) {
    if (!CHANNEL_ID_PATTERN.test(channelId || '') || !validContext(context)) return false;
    this.untrack(channelId, { persist: false });
    let channel;
    try { channel = this.createChannel(`ltds-viewer-review:${channelId}`); } catch { return false; }
    if (!channel || typeof channel.postMessage !== 'function' || typeof channel.close !== 'function') return false;
    const record = {
      channelId,
      channel,
      context: Object.freeze({
        ...(context.sessionMode === 'published'
          ? { sessionMode: 'published', outputId: context.outputId }
          : { attemptId: context.attemptId }),
        modelId: context.modelId,
        modelVersionId: context.modelVersionId,
        sessionTtlSeconds: context.sessionTtlSeconds,
      }),
      expiresAt: null,
      expiresAtMs: 0,
      pending: false,
      issuance: null,
      awaitingRenewed: false,
      activeRequestId: null,
      usedRequestIds: new Set(),
      retryIndex: 0,
      retryTimer: null,
      renewedTimer: null,
      measurementPending: false,
      measurementRequestIds: new Set(),
      restored: restoring,
      updatedAt: this.now(),
    };
    channel.onmessage = event => this.handleMessage(channelId, event?.data);
    this.records.set(channelId, record);
    if (!restoring) this.persistContexts();
    return true;
  }

  has(channelId) { return this.records.has(channelId); }

  navigate(channelId, url) {
    const record = this.records.get(channelId);
    if (!record) return false;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    if (parsed.origin !== this.origin || parsed.username || parsed.password
      || !/^\/session\/[0-9a-f-]{36}$/i.test(parsed.pathname)
      || hash.get('reviewController') !== channelId) return false;
    record.channel.postMessage({ version: 1, type: 'ltds-viewer:navigate', url: parsed.href });
    return true;
  }

  untrack(channelId, { persist = true } = {}) {
    const record = this.records.get(channelId);
    if (!record) return false;
    record.issuance?.abortController.abort();
    record.issuance?.reject(new Error('renewal controller closed'));
    if (record.retryTimer) this.clearTimer(record.retryTimer);
    if (record.renewedTimer) this.clearTimer(record.renewedTimer);
    record.channel.onmessage = null;
    try { record.channel.close(); } catch {}
    this.records.delete(channelId);
    if (persist) this.persistContexts();
    return true;
  }

  unavailable(record, reason) {
    if (this.records.get(record.channelId) !== record) return;
    try {
      record.channel.postMessage({
        version: 1, type: 'ltds-viewer:session-unavailable',
        requestId: record.activeRequestId, modelId: record.context.modelId, reason,
      });
    } catch { /* The denial still retires the record if its channel closed. */ }
    finally { this.untrack(record.channelId); }
  }

  async handleMessage(channelId, data) {
    const record = this.records.get(channelId);
    if (!record) return false;
    const now = this.now();
    if (data?.type === 'ltds-viewer:measurement-request') return this.handleMeasurementRequest(record, data);
    if (exactKeys(data, ['version', 'type', 'modelId', 'expiresAt'])
      && data.version === 1 && data.type === 'ltds-viewer:ready' && data.modelId === record.context.modelId
      && validSessionExpiry(data.expiresAt, record, now)) {
      record.expiresAt = data.expiresAt;
      record.expiresAtMs = Date.parse(data.expiresAt);
      record.updatedAt = now;
      record.restored = false;
      this.persistContexts();
      return true;
    }
    if (exactKeys(data, ['version', 'type', 'requestId', 'modelId', 'expiresAt'])
      && data.version === 1 && data.type === 'ltds-viewer:session-renewed'
      && data.modelId === record.context.modelId && data.requestId === record.activeRequestId
      && record.awaitingRenewed && validSessionExpiry(data.expiresAt, record, now)) {
      const renewedExpiryMs = Date.parse(data.expiresAt);
      if (renewedExpiryMs > record.expiresAtMs) {
        record.expiresAt = data.expiresAt;
        record.expiresAtMs = renewedExpiryMs;
      }
      // The workspace and Viewer renew on the same lead time. A grant can be
      // capped to the unchanged workspace expiry during that race. Treat the
      // authenticated response as complete so the Viewer may retry after the
      // workspace session advances instead of wedging this channel forever.
      record.awaitingRenewed = false;
      record.activeRequestId = null;
      record.retryIndex = 0;
      record.updatedAt = now;
      this.persistContexts();
      if (record.renewedTimer) this.clearTimer(record.renewedTimer);
      record.renewedTimer = null;
      return true;
    }
    if (exactKeys(data, ['version', 'type', 'requestId', 'modelId', 'retryable'])
      && data.version === 1 && data.type === 'ltds-viewer:session-renewal-failed'
      && data.modelId === record.context.modelId && data.requestId === record.activeRequestId
      && record.awaitingRenewed && typeof data.retryable === 'boolean') {
      if (!data.retryable) {
        this.untrack(channelId);
        return true;
      }
      if (record.renewedTimer) this.clearTimer(record.renewedTimer);
      record.renewedTimer = null;
      record.awaitingRenewed = false;
      record.activeRequestId = null;
      return true;
    }
    // A surviving model need not reload after its workspace returns. Learn its
    // expiry once on a restored random channel, then use the normal exact
    // request checks. Only the authenticated issueGrant endpoint grants access;
    // validIssuedGrant still pins mode/model/version to the saved descriptor.
    if (record.restored && exactKeys(data, ['version','type','requestId','modelId','expiresAt'])
      && data.version === 1 && data.type === 'ltds-viewer:session-expiring'
      && data.modelId === record.context.modelId && CHANNEL_ID_PATTERN.test(data.requestId || '')) {
      const expiresAtMs = Date.parse(data.expiresAt || '');
      if (Number.isFinite(expiresAtMs) && expiresAtMs >= now - CONTEXT_RETENTION_MS
        && expiresAtMs <= now + RENEWAL_LEAD_MS) {
        record.expiresAt = data.expiresAt;
        record.expiresAtMs = expiresAtMs;
        record.restored = false;
      }
    }
    if (!exactKeys(data, ['version', 'type', 'requestId', 'modelId', 'expiresAt'])
      || data.version !== 1 || data.type !== 'ltds-viewer:session-expiring'
      || data.modelId !== record.context.modelId || data.expiresAt !== record.expiresAt
      || !CHANNEL_ID_PATTERN.test(data.requestId || '') || record.usedRequestIds.has(data.requestId)
      || record.pending || record.retryTimer || record.awaitingRenewed || !record.expiresAtMs
      || record.expiresAtMs - now > RENEWAL_LEAD_MS) return false;
    if (record.usedRequestIds.size >= 32) record.usedRequestIds.delete(record.usedRequestIds.values().next().value);
    record.usedRequestIds.add(data.requestId);
    record.activeRequestId = data.requestId;
    return this.renew(record);
  }

  async handleMeasurementRequest(record, data) {
    if (!this.subject || typeof this.measurementRequest !== 'function'
      || !exactKeys(data, ['version','type','requestId','modelId','modelVersionId','viewerToken','operation','payload'])
      || data.version !== 1 || !CHANNEL_ID_PATTERN.test(data.requestId || '')
      || data.modelId !== record.context.modelId || data.modelVersionId !== record.context.modelVersionId
      || record.measurementPending || record.measurementRequestIds.has(data.requestId)
      || !['capabilities','create','list','status','cancel'].includes(data.operation)
      || typeof data.viewerToken !== 'string' || data.viewerToken.length > 128) return false;
    if (record.measurementRequestIds.size >= 128) record.measurementRequestIds.delete(record.measurementRequestIds.values().next().value);
    record.measurementRequestIds.add(data.requestId);
    record.measurementPending = true;
    const subject = this.subject;
    const response = { version: 1, type: 'ltds-viewer:measurement-response', requestId: data.requestId,
      modelId: record.context.modelId, modelVersionId: record.context.modelVersionId };
    try {
      const result = await this.measurementRequest(record.context, data);
      if (this.subject !== subject || this.records.get(record.channelId) !== record) return false;
      record.channel.postMessage({ ...response, ok: true, result });
      return true;
    } catch (error) {
      if (this.subject !== subject || this.records.get(record.channelId) !== record) return false;
      try { record.channel.postMessage({ ...response, ok: false,
        code: safeMeasurementCalculationErrorCode(error?.code),
        status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503 }); } catch {}
      return false;
    } finally { record.measurementPending = false; }
  }

  async renew(record) {
    if (this.records.get(record.channelId) !== record || record.pending || record.awaitingRenewed) return false;
    if (record.retryTimer) {
      this.clearTimer(record.retryTimer);
      record.retryTimer = null;
    }
    record.pending = true;
    const issuance = { abortController: new AbortController(), timer: null, reject: null };
    record.issuance = issuance;
    try {
      // Bound issuance itself, not only the subsequent grant redemption. A
      // stalled fetch otherwise keeps pending true and rejects every retry.
      const deadline = new Promise((_, reject) => {
        issuance.reject = reject;
        issuance.timer = this.setTimer(() => {
          issuance.abortController.abort();
          reject(new Error('renewal grant issuance timed out'));
        }, GRANT_ISSUANCE_TIMEOUT_MS);
      });
      const result = await Promise.race([
        this.issueGrant(record.context, { signal: issuance.abortController.signal }), deadline,
      ]);
      if (!validIssuedGrant(result, record.context) || this.records.get(record.channelId) !== record) {
        this.unavailable(record, 'scope-changed');
        return false;
      }
      record.retryIndex = 0;
      record.awaitingRenewed = true;
      record.channel.postMessage({ version: 1, type: 'ltds-viewer:renew-session', requestId: record.activeRequestId, grant: result.grant });
      const requestId = record.activeRequestId;
      record.renewedTimer = this.setTimer(() => {
        if (this.records.get(record.channelId) !== record || record.activeRequestId !== requestId) return;
        record.awaitingRenewed = false;
        record.activeRequestId = null;
        record.renewedTimer = null;
      }, 35_000);
      return true;
    } catch (error) {
      if (this.records.get(record.channelId) !== record) return false;
      if (error?.status === 401 || error?.status === 403 || error?.status === 410) {
        this.unavailable(record, 'authorization-required');
        return false;
      }
      if (record.retryIndex < this.retryDelays.length) {
        const delay = this.retryDelays[record.retryIndex++];
        record.retryTimer = this.setTimer(() => this.renew(record), delay);
      }
      return false;
    } finally {
      if (issuance.timer) this.clearTimer(issuance.timer);
      if (record.issuance === issuance) {
        record.issuance = null;
        record.pending = false;
      }
    }
  }

  dispose() {
    this.suspend();
  }
}
