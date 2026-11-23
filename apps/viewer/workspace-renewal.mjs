import {requestWorkspaceRenewalGrant,exactRenewalOrigin} from './workspace-renewal-transport.mjs';
export const WORKSPACE_RENEWAL_PROTOCOL_VERSION = 1;
// A workspace session lasts at most 30 minutes. Renewing with 12 minutes left is
// 60% of the way through and leaves room for retries before anything pauses.
export const WORKSPACE_RENEWAL_LEAD_MS = 12 * 60 * 1000;
const WORKSPACE_RENEWAL_LEAD_FRACTION = 0.4;
const MINIMUM_RENEWAL_INTERVAL_MS = 30 * 1000;
const MAXIMUM_JITTER_MS = 60 * 1000;

const RESPONSE_TIMEOUT_MS = 10 * 1000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const RECOVERY_COOLDOWN_MS = 60_000;
const ALTERNATE_ENDPOINT_TIMEOUT_MS = 5_000;
// Attempts that must fail after real expiry before sign-in is even considered.
const EXPIRED_FAILURES_BEFORE_SIGN_IN = 2;
const CHANNEL_NAME = 'ltds-viewer-workspace-renewal';
const LOCK_PREFIX = 'ltds-viewer-workspace-renewal:';
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
  const renewalOrigin = value.renewalOrigin !== value.controllerOrigin ? exactHttpsOrigin(value.renewalOrigin) : null;
  return { session, controllerOrigin: value.controllerOrigin, renewalOrigin, accessToken: value.accessToken, expiresAtMs };
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
    random = () => Math.random(),
    onSession = () => {},
    onExpired = () => {},
    onPaused = () => {},
    onResumed = () => {},
    onSignInRequired = () => {},
  }) {
    const checked = sessionEnvelope({ ...envelope, accessToken: envelope.accessToken || accessToken });
    if (!TOKEN_PATTERN.test(accessToken || '')) throw new Error('invalid workspace bearer');
    this.controllerWindow = controllerWindow && !controllerWindow.closed ? controllerWindow : null;
    this.controllerOrigin = checked.controllerOrigin;
    this.renewalOrigin = checked.renewalOrigin;
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
    this.random = random;
    this.onSession = onSession;
    this.onExpired = onExpired;
    this.onPaused = onPaused;
    this.onResumed = onResumed;
    this.onSignInRequired = onSignInRequired;
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
    this.lastRenewedAtMs = -Infinity;
    this.expiredFailures = 0;
    this.lastFailureReadable = false;
    this.signInRequested = false;
    this.adopting = null;
    this.channel = null;
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
    this.openChannel();
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
      if (!this.hasTransport()) { this.expire('expired'); return; }
      // Expiry is a new recovery opportunity even if earlier attempts used the budget.
      if (!this.pendingRequestId) this.retryAttempt = 0;
      this.requestRenewal('expiry');
    }, remaining);
    if (this.hasTransport()) {
      this.renewalTimer = this.setTimer(() => this.requestRenewal('timer'), this.renewalDelay(remaining));
    }
  }

  // Jitter only ever moves a renewal earlier. When Operations caps the session
  // at its own remaining sign-in time, the wait shrinks with it instead of
  // spinning on an expiry that can no longer advance.
  renewalDelay(remaining) {
    const lead = Math.min(WORKSPACE_RENEWAL_LEAD_MS, remaining * WORKSPACE_RENEWAL_LEAD_FRACTION);
    const jitter = this.random() * Math.min(MAXIMUM_JITTER_MS, remaining * 0.05);
    return Math.max(MINIMUM_RENEWAL_INTERVAL_MS, remaining - lead - jitter);
  }

  hasTransport(){return Boolean(this.controllerWindow&&!this.controllerWindow.closed||this.viewerOrigin);}

  requestIfDue(reason) {
    const remaining = this.expiresAtMs - this.now();
    if (remaining <= WORKSPACE_RENEWAL_LEAD_MS && (remaining <= 0 || this.now() - this.lastRenewedAtMs >= MINIMUM_RENEWAL_INTERVAL_MS)) {
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
      attempt.abortController.abort();this.transportAttempt=null;this.lastFailureReadable=false;this.finishRequest(requestId);this.fallbackToOpener(requestId);
    },RESPONSE_TIMEOUT_MS);
    const startedWith=this.expiresAtMs;
    const current=()=>!this.disposed&&this.transportAttempt===attempt&&this.pendingRequestId===requestId;
    const renew=async()=>{
      const grant=await this.requestGrant(requestId,attempt.abortController.signal);
      if(!current())return;
      this.transportAttempt=null;
      await this.redeemGrant(grant,requestId,'cors');
    };
    try{
      const locks=this.windowRef.navigator?.locks;
      if(!locks?.request){await renew();return;}
      // Tabs sharing one session (a duplicated tab) renew once. Whichever tab
      // waited adopts the holder's result instead of asking Operations again.
      const name=LOCK_PREFIX+this.session.id;
      const held=await locks.request(name,{ifAvailable:true},async lock=>{if(!lock)return false;if(current())await renew();return true;});
      if(held||!current())return;
      await locks.request(name,{signal:attempt.abortController.signal},async()=>{
        if(!current())return;
        if(this.expiresAtMs<=startedWith)await this.adoptServerSession();
        if(this.expiresAtMs>startedWith){this.settleRequest(requestId,attempt);return;}
        if(current())await renew();
      });
    }catch(error){
      if(this.disposed||this.transportAttempt!==attempt)return;
      this.transportAttempt=null;this.finishRequest(requestId);
      // Operations answered for this exact identity: 401 means its sign-in ended
      // and 403 means this account may no longer use the workspace.
      if(error?.renewalAuthenticationRequired===true){this.expire(error.renewalStatus===401?'signed-out':'revoked');return;}
      this.lastFailureReadable=Number.isInteger(error?.renewalStatus);
      // Browser privacy restrictions or a temporary network failure can block
      // CORS while the original Ops tab still has a valid authenticated session.
      // Try that existing channel silently in the same bounded attempt.
      this.fallbackToOpener(requestId);
    }
  }

  // The same-site host comes first: its Access cookie is first-party to Viewer,
  // so SameSite rules and third-party cookie blocking do not apply. It is only a
  // route. A refusal there ends the session only when the pinned controller
  // cannot be reached to say otherwise.
  async requestGrant(requestId,signal){
    const request=(endpointOrigin,requestSignal)=>requestWorkspaceRenewalGrant({controllerOrigin:this.controllerOrigin,endpointOrigin,viewerOrigin:this.viewerOrigin,subject:this.session.subject,sessionId:this.session.id,requestId,signal:requestSignal,fetchImpl:this.fetchImpl,now:this.now});
    if(!this.renewalOrigin)return request(this.controllerOrigin,signal);
    const alternate=new AbortController(),abort=()=>alternate.abort();
    signal.addEventListener('abort',abort,{once:true});
    const timer=this.setTimer(abort,ALTERNATE_ENDPOINT_TIMEOUT_MS);
    let refused=null;
    try{return await request(this.renewalOrigin,alternate.signal);}
    catch(error){if(signal.aborted)throw error;refused=error;}
    finally{this.clearTimer(timer);signal.removeEventListener('abort',abort);}
    try{return await request(this.controllerOrigin,signal);}
    catch(error){
      if(!Number.isInteger(error?.renewalStatus)&&refused?.renewalAuthenticationRequired===true&&refused.renewalStatus===403)throw refused;
      throw error;
    }
  }

  openChannel(){
    const Channel=this.windowRef.BroadcastChannel;
    if(typeof Channel!=='function'||this.channel)return;
    try{this.channel=new Channel(CHANNEL_NAME);}catch{this.channel=null;return;}
    this.channel.onmessage=event=>{
      const data=event.data;
      if(this.disposed||!exactKeys(data,['version','type','sessionId','expiresAt'])||data.version!==this.protocolVersion
        ||data.type!=='renewed'||data.sessionId!==this.session.id||!(Date.parse(data.expiresAt)>this.expiresAtMs))return;
      // The message is only a hint. The server decides with this tab's bearer.
      void this.adoptServerSession();
    };
  }

  // Reads the session this tab already holds; it cannot extend anything.
  adoptServerSession(){
    if(this.disposed)return Promise.resolve(false);
    this.adopting??=this.readServerSession().then(result=>result==='renewed').finally(()=>{this.adopting=null;});
    return this.adopting;
  }

  async readServerSession(){
    const abort=new AbortController(),timer=this.setTimer(()=>abort.abort(),RESPONSE_TIMEOUT_MS);
    try{
      const response=await this.fetchImpl('/api/v1/admin-sessions/current',{headers:{Authorization:`Bearer ${this.accessToken}`,Accept:'application/json'},redirect:'error',cache:'no-store',signal:abort.signal});
      if(response.status===401)return 'ended';
      if(!response.ok)return 'unknown';
      const body=await response.json(),envelope={...body,accessToken:this.accessToken};
      const checked=sessionEnvelope(envelope,{origin:this.controllerOrigin,sessionId:this.session.id,subject:this.session.subject,accessToken:this.accessToken});
      if(this.disposed)return 'unknown';
      if(checked.expiresAtMs<=this.expiresAtMs)return 'unchanged';
      this.installRenewed(checked,envelope);
      return 'renewed';
    }catch{return 'unknown';}
    finally{this.clearTimer(timer);}
  }

  settleRequest(requestId,attempt){
    if(this.transportAttempt===attempt)this.transportAttempt=null;
    this.finishRequest(requestId);
  }

  // Access refusing a fetch and the network failing look the same to a page, so
  // sign-in is offered only after real expiry, repeated unreadable failures, and
  // Viewer itself confirming that this session is over. Renewal keeps trying.
  async confirmSignInRequired(){
    if(this.disposed||this.signInRequested||this.expiresAtMs>this.now())return;
    this.signInRequested=true;
    const result=await this.readServerSession();
    if(this.disposed||result==='renewed')return;
    if(result==='ended'&&this.expiresAtMs<=this.now()){this.onSignInRequired();return;}
    this.signInRequested=false;
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
    if (this.expiresAtMs <= this.now()) {
      this.expiredFailures = this.lastFailureReadable ? 0 : this.expiredFailures + 1;
      if (this.expiredFailures >= EXPIRED_FAILURES_BEFORE_SIGN_IN) void this.confirmSignInRequired();
    }
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      if (this.expiresAtMs <= this.now()) this.pauseForRecovery();
      else this.scheduleCooldown('cooldown');
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
    this.lastFailureReadable=true; // Operations just authorized this identity.
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
      this.installRenewed(checked, body);
      try { this.channel?.postMessage({ version: this.protocolVersion, type: 'renewed', sessionId: this.session.id, expiresAt: this.session.expiresAt }); } catch { /* Other tabs renew for themselves. */ }
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

  installRenewed(checked, body) {
    this.session = checked.session;
    this.expiresAtMs = checked.expiresAtMs;
    this.renewalOrigin = checked.renewalOrigin;
    this.retryAttempt = 0;
    this.lastRenewedAtMs = this.now();
    this.expiredFailures = 0;
    this.lastFailureReadable = false;
    this.signInRequested = false;
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.schedule();
    this.onSession(body);
    if (this.paused) { this.paused = false; this.onResumed(); }
    for (const finish of [...this.renewalWaiters]) finish(true);
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
    this.scheduleCooldown('recovery-cooldown');
    return false;
  }

  scheduleCooldown(reason) {
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      this.retryAttempt = 0;
      this.requestRenewal(reason);
    }, RECOVERY_COOLDOWN_MS);
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
    try{this.channel?.close();}catch{}
    this.channel=null;
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
