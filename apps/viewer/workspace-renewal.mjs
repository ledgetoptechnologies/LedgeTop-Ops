import {requestWorkspaceRenewalGrant,exactRenewalOrigin} from './workspace-renewal-transport.mjs';
export const WORKSPACE_RENEWAL_PROTOCOL_VERSION = 1;
export const WORKSPACE_RENEWAL_LEAD_MS = 5 * 60 * 1000;

const RESPONSE_TIMEOUT_MS = 10 * 1000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const RECOVERY_COOLDOWN_MS = 60_000;
const GRANT_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9._:@-]{1,200}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function exactHttpsOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

function sessionEnvelope(value, expected = {}) {
  const session = value?.session;
  const expiresAtMs = Date.parse(session?.expiresAt || '');
  if (!session || !SESSION_ID_PATTERN.test(session.id || '') || !SUBJECT_PATTERN.test(session.subject || '') || !Number.isFinite(expiresAtMs)) throw new Error('invalid workspace session response');
  if (!exactHttpsOrigin(value?.controllerOrigin)) throw new Error('invalid workspace controller response');
  if (expected.origin && value.controllerOrigin !== expected.origin) throw new Error('workspace controller origin changed');
  if (expected.sessionId && session.id !== expected.sessionId) throw new Error('workspace session identity changed');
  if (expected.subject && session.subject !== expected.subject) throw new Error('workspace session subject changed');
  if (expected.accessToken && value.accessToken !== expected.accessToken) throw new Error('workspace bearer changed during renewal');
  if (value.accessToken !== undefined && !TOKEN_PATTERN.test(value.accessToken)) throw new Error('invalid workspace bearer');
  if (expiresAtMs <= Date.now()) throw new Error('workspace session expired');
  return { session, controllerOrigin: value.controllerOrigin, accessToken: value.accessToken, expiresAtMs };
}

export class WorkspaceSessionRenewal {
  constructor({
    controllerWindow,
    envelope,
    accessToken,
    fetchImpl = fetch,
    windowRef = window,
    documentRef = document,
    now = () => Date.now(),
    setTimer = (handler, delay) => setTimeout(handler, delay),
    clearTimer = (timer) => clearTimeout(timer),
    randomUUID = () => crypto.randomUUID(),
    onSession = () => {},
    onExpired = () => {},
    onPaused = () => {},
    onResumed = () => {},
  }) {
    const checked = sessionEnvelope({ ...envelope, accessToken: envelope.accessToken || accessToken });
    if (!TOKEN_PATTERN.test(accessToken || '')) throw new Error('invalid workspace bearer');
    this.controllerWindow = controllerWindow && !controllerWindow.closed ? controllerWindow : null;
    this.controllerOrigin = checked.controllerOrigin;
    this.protocolVersion = WORKSPACE_RENEWAL_PROTOCOL_VERSION;
    this.accessToken = accessToken;
    this.session = checked.session;
    this.expiresAtMs = checked.expiresAtMs;
    // Native Window.fetch requires its own realm receiver. Never invoke a
    // captured browser API as a method of this renewal controller.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.windowRef = windowRef;
    this.documentRef = documentRef;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.randomUUID = randomUUID;
    this.onSession = onSession;
    this.onExpired = onExpired;
    this.onPaused = onPaused;
    this.onResumed = onResumed;
    this.paused = false;
    this.renewalTimer = null;
    this.expiryTimer = null;
    this.responseTimer = null;
    this.retryTimer = null;
    this.pendingRequestId = null;
    this.redemptionAttempt = null;
    this.transportAttempt = null;
    this.viewerOrigin = exactRenewalOrigin(windowRef.location?.origin);
    // Prefer the authority-backed credentialed request even when an opener
    // exists: the Ops tab may have navigated or reloaded since launch.
    this.preferBackground = true;
    this.retryAttempt = 0;
    this.disposed = false;
    this.renewalWaiters = new Set();
    this.boundMessage = (event) => this.handleMessage(event);
    this.boundFocus = () => this.requestIfDue('focus');
    this.boundVisibility = () => { if (this.documentRef.visibilityState === 'visible') this.requestIfDue('visibility'); };
    this.boundPageShow = () => this.requestIfDue('pageshow');
    this.boundOnline = () => this.requestIfDue('online');
  }

  start() {
    this.windowRef.addEventListener('message', this.boundMessage);
    this.windowRef.addEventListener('focus', this.boundFocus);
    this.windowRef.addEventListener('pageshow', this.boundPageShow);
    this.windowRef.addEventListener('online', this.boundOnline);
    this.documentRef.addEventListener('visibilitychange', this.boundVisibility);
    this.schedule();
    this.post({ type: 'ltds-viewer:workspace-ready', sessionId: this.session.id, subject: this.session.subject, expiresAt: this.session.expiresAt });
  }

  post(message) {
    if (!this.controllerWindow || this.controllerWindow.closed || this.disposed) return false;
    this.controllerWindow.postMessage({ version: this.protocolVersion, ...message }, this.controllerOrigin);
    return true;
  }

  schedule() {
    if (this.disposed) return;
    for (const timer of [this.renewalTimer, this.expiryTimer]) if (timer) this.clearTimer(timer);
    const remaining = this.expiresAtMs - this.now();
    if (remaining <= 0) {
      if (this.hasTransport()) return this.requestRenewal('late-schedule');
      return this.expire('expired');
    }
    this.expiryTimer = this.setTimer(() => {
      if (this.hasTransport()) this.requestRenewal('expiry');
      else this.expire('expired');
    }, remaining);
    if (this.hasTransport()) {
      this.renewalTimer = this.setTimer(() => this.requestRenewal('timer'), Math.max(1_000, remaining - WORKSPACE_RENEWAL_LEAD_MS));
    }
  }

  hasTransport(){return Boolean(this.controllerWindow&&!this.controllerWindow.closed||this.viewerOrigin);}

  requestIfDue(reason) {
    if (this.expiresAtMs - this.now() <= WORKSPACE_RENEWAL_LEAD_MS) {
      // A later focus/visibility/pageshow is a new recovery opportunity after
      // a bounded transient retry run was exhausted while the tab slept.
      if (!this.pendingRequestId && this.retryAttempt >= RETRY_DELAYS_MS.length) this.retryAttempt = 0;
      this.requestRenewal(reason);
    }
  }

  // Await an authority-backed renewal before turning a racing API 401 into
  // interactive recovery. This never renews a session from its bearer alone.
  waitForRenewal({ signal, timeoutMs = 25_000, whileExpired = false } = {}) {
    if (this.disposed || signal?.aborted || !this.hasTransport()) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer;
      const finish = renewed => {
        this.renewalWaiters.delete(finish);
        if (timer) this.clearTimer(timer);
        signal?.removeEventListener('abort', abort);
        resolve(renewed);
      };
      const abort = () => finish(false);
      this.renewalWaiters.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      timer = this.setTimer(() => {
        if (whileExpired && this.expiresAtMs <= this.now() && !this.disposed) {
          this.pauseForRecovery();
          return; // A protected request remains paused until fresh authority or cancellation.
        }
        finish(false);
      }, Math.min(30_000, Math.max(1, Number(timeoutMs) || 25_000)));
      if (!this.pendingRequestId && !this.requestRenewal('api-unauthorized') && !this.paused) finish(false);
    });
  }

  requestRenewal(reason) {
    if (!this.disposed && this.expiresAtMs <= this.now() && !this.paused) {
      this.paused = true;
      this.onPaused();
    }
    if (this.disposed || this.pendingRequestId) return false;
    if (!this.hasTransport()){if(this.expiresAtMs<=this.now())this.expire('expired');return false;}
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      if (this.expiresAtMs <= this.now()) this.pauseForRecovery();
      return false;
    }
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const requestId = this.randomUUID();
    this.pendingRequestId = requestId;
    this.retryAttempt += 1;
    if(this.viewerOrigin&&(this.preferBackground||!this.controllerWindow||this.controllerWindow.closed)){
      void this.requestBackground(requestId);
      return true;
    }
    return this.requestOpener(requestId);
  }

  requestOpener(requestId) {
    if (!this.post({
      type: 'ltds-viewer:workspace-session-expiring',
      requestId,
      sessionId: this.session.id,
      subject: this.session.subject,
      expiresAt: this.session.expiresAt,
    })) {
      this.pendingRequestId = null;
      this.scheduleRetry();
      return false;
    }
    this.responseTimer = this.setTimer(() => {
      if (this.pendingRequestId !== requestId) return;
      this.pendingRequestId = null;
      this.responseTimer = null;
      this.preferBackground = Boolean(this.viewerOrigin);
      this.postFailure('renewal response timed out', true, requestId);
      this.scheduleRetry();
    }, RESPONSE_TIMEOUT_MS);
    return true;
  }

  async requestBackground(requestId){
    const attempt={requestId,abortController:new AbortController()};this.transportAttempt=attempt;
    this.responseTimer=this.setTimer(()=>{
      if(this.disposed||this.transportAttempt!==attempt)return;
      attempt.abortController.abort();this.transportAttempt=null;this.finishRequest(requestId);this.fallbackToOpener(requestId);
    },RESPONSE_TIMEOUT_MS);
    try{
      const grant=await requestWorkspaceRenewalGrant({controllerOrigin:this.controllerOrigin,viewerOrigin:this.viewerOrigin,subject:this.session.subject,sessionId:this.session.id,requestId,signal:attempt.abortController.signal,fetchImpl:this.fetchImpl,now:this.now});
      if(this.disposed||this.transportAttempt!==attempt||this.pendingRequestId!==requestId)return;
      this.transportAttempt=null;
      await this.redeemGrant(grant,requestId,'cors');
    }catch(error){
      if(this.disposed||this.transportAttempt!==attempt)return;
      this.transportAttempt=null;this.finishRequest(requestId);
      if(error?.renewalAuthenticationRequired===true){this.expire('revoked');return;}
      // Browser privacy restrictions or a temporary network failure can block
      // CORS while the original Ops tab still has a valid authenticated session.
      // Try that existing channel silently in the same bounded attempt.
      this.fallbackToOpener(requestId);
    }
  }

  fallbackToOpener(requestId) {
    if(this.controllerWindow&&!this.controllerWindow.closed){
      this.pendingRequestId=requestId;
      if(this.requestOpener(requestId))return;
    }
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.disposed) return;
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      if (this.expiresAtMs <= this.now()) this.pauseForRecovery();
      return;
    }
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    const delay = RETRY_DELAYS_MS[this.retryAttempt - 1];
    this.retryTimer = this.setTimer(() => this.requestRenewal('retry'), delay);
  }

  async handleMessage(event) {
    if (this.disposed || !this.controllerWindow || event.source !== this.controllerWindow || event.origin !== this.controllerOrigin) return;
    const message = event.data;
    if (!exactKeys(message, ['version','type','requestId','grant']) || message.version !== this.protocolVersion || message.type !== 'ltds-viewer:renew-workspace-session') return;
    if (message.requestId !== this.pendingRequestId || this.redemptionAttempt || !GRANT_PATTERN.test(message.grant || '')) return;
    if(this.transportAttempt)return;
    return this.redeemGrant(message.grant,this.pendingRequestId,'opener');
  }

  async redeemGrant(grant,requestId,transport){
    if (this.responseTimer) this.clearTimer(this.responseTimer);
    const attempt = { requestId, abortController: new AbortController() };
    this.redemptionAttempt = attempt;
    this.responseTimer = this.setTimer(() => {
      if (this.disposed || this.redemptionAttempt !== attempt) return;
      attempt.abortController.abort();
      this.finishRequest(requestId);
      this.postFailure('workspace grant redemption timed out', true, requestId);
      this.scheduleRetry();
    }, RESPONSE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl('/api/v1/admin-sessions/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant }),
        redirect: 'error',
        cache: 'no-store',
        signal: attempt.abortController.signal,
      });
      if(transport==='cors'&&(response.redirected||response.url!==this.viewerOrigin+'/api/v1/admin-sessions/redeem'||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')))throw new Error('invalid workspace redemption response');
      const body = await response.json().catch(() => ({}));
      if (this.disposed || this.redemptionAttempt !== attempt) return;
      if (response.status === 401 || response.status === 403) {
        this.finishRequest(requestId);
        this.postFailure('workspace authorization expired', false, requestId);
        this.expire('revoked');
        return;
      }
      if (!response.ok) throw new Error(body.error || `renewal failed (${response.status})`);
      let checked;
      try { checked = sessionEnvelope(body, {
        origin: this.controllerOrigin,
        sessionId: this.session.id,
        subject: this.session.subject,
        accessToken: this.accessToken,
      }); } catch (error) {
        if (/identity changed|subject changed|bearer changed|origin changed/.test(error.message)) {
          this.finishRequest(requestId);
          this.expire('revoked');
          return;
        }
        throw error;
      }
      this.finishRequest(requestId);
      this.session = checked.session;
      this.expiresAtMs = checked.expiresAtMs;
      this.retryAttempt = 0;
      if (this.retryTimer) this.clearTimer(this.retryTimer);
      this.retryTimer = null;
      this.schedule();
      this.onSession(body);
      if (this.paused) { this.paused = false; this.onResumed(); }
      for (const finish of [...this.renewalWaiters]) finish(true);
      this.post({
        type: 'ltds-viewer:workspace-session-renewed',
        requestId,
        sessionId: this.session.id,
        subject: this.session.subject,
        expiresAt: this.session.expiresAt,
      });
    } catch (error) {
      if (this.disposed || this.redemptionAttempt !== attempt) return;
      this.finishRequest(requestId);
      this.postFailure(String(error?.message || error), true, requestId);
      this.scheduleRetry();
    }
  }

  finishRequest(requestId) {
    if (this.pendingRequestId !== requestId) return false;
    if (this.responseTimer) this.clearTimer(this.responseTimer);
    this.responseTimer = null;
    this.pendingRequestId = null;
    this.redemptionAttempt = null;
    return true;
  }

  postFailure(error, retryable, requestId) {
    this.post({
      type: 'ltds-viewer:workspace-session-renewal-failed',
      requestId,
      retryable,
    });
  }

  pauseForRecovery() {
    if (this.disposed) return false;
    if (!this.paused) { this.paused = true; this.onPaused(); }
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      this.retryAttempt = 0;
      this.requestRenewal('recovery-cooldown');
    }, RECOVERY_COOLDOWN_MS);
    return false;
  }

  expire(reason) {
    if (this.disposed) return false;
    this.dispose();
    this.onExpired(reason);
    return false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const finish of [...this.renewalWaiters]) finish(false);
    this.redemptionAttempt?.abortController.abort();
    this.transportAttempt?.abortController.abort();
    this.transportAttempt=null;
    this.redemptionAttempt = null;
    for (const timer of [this.renewalTimer, this.expiryTimer, this.responseTimer, this.retryTimer]) if (timer) this.clearTimer(timer);
    this.windowRef.removeEventListener('message', this.boundMessage);
    this.windowRef.removeEventListener('focus', this.boundFocus);
    this.windowRef.removeEventListener('pageshow', this.boundPageShow);
    this.windowRef.removeEventListener('online', this.boundOnline);
    this.documentRef.removeEventListener('visibilitychange', this.boundVisibility);
    this.pendingRequestId = null;
  }
}

export function validateWorkspaceSessionEnvelope(value, expected) {
  return sessionEnvelope(value, expected);
}
