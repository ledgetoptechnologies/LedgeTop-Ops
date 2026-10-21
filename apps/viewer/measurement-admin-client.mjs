const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['capabilities','create','list','status','cancel']);
const failure = (code, status = 503) => Object.assign(new Error(code.replaceAll('_',' ')), { code, status });

// Connect handleMessage ONLY to the registered review BroadcastChannel. This
// client never reads or accepts a workspace administrative token.
export function createMeasurementAdminClient({ context, token, send, timeoutMs = 35_000, uuid = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let disposed = false, queue = Promise.resolve();
  const pending = new Map();
  function start(operation, payload) {
    if (disposed) return Promise.reject(failure('measurement_controller_closed'));
    const current = context(), viewerToken = token();
    if (!current?.modelId || !current?.modelVersionId || !viewerToken) return Promise.reject(failure('measurement_admin_unavailable',403));
    if (!OPERATIONS.has(operation) || !payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16_384) return Promise.reject(failure('measurement_request_invalid',400));
    const requestId = uuid();
    if (!UUID.test(requestId)) return Promise.reject(failure('measurement_request_invalid',400));
    return new Promise((resolve,reject) => {
      const timer = setTimer(() => { pending.delete(requestId); reject(failure('measurement_workspace_unavailable')); }, timeoutMs);
      pending.set(requestId,{resolve,reject,timer,modelId:current.modelId,modelVersionId:current.modelVersionId});
      try {
        const sent = send({version:1,type:'ltds-viewer:measurement-request',requestId,modelId:current.modelId,modelVersionId:current.modelVersionId,viewerToken,operation,payload});
        if (sent === false) throw failure('measurement_workspace_unavailable');
      } catch (error) { clearTimer(timer);pending.delete(requestId);reject(error); }
    });
  }
  function request(operation,payload={}) {
    // Controller admits one request per model channel. Serializing also keeps
    // capability checks, job submission and polling in deterministic order.
    const result = queue.then(() => start(operation,payload));
    queue = result.catch(() => {});
    return result;
  }
  function handleMessage(data) {
    if (!data || data.version !== 1 || data.type !== 'ltds-viewer:measurement-response' || !UUID.test(data.requestId || '') || typeof data.ok !== 'boolean') return false;
    const item = pending.get(data.requestId);
    if (!item || data.modelId !== item.modelId || data.modelVersionId !== item.modelVersionId) return false;
    if (data.ok ? (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) : (typeof data.code !== 'string' || !/^measurement_[a-z_]{1,80}$/.test(data.code) || !Number.isInteger(data.status) || data.status < 400 || data.status > 599)) return false;
    pending.delete(data.requestId);clearTimer(item.timer);
    const current = context();
    if (current?.modelId !== item.modelId || current?.modelVersionId !== item.modelVersionId) item.reject(failure('measurement_scope_changed',403));
    else if (data.ok) item.resolve(data.result);
    else item.reject(failure(data.code,data.status));
    return true;
  }
  function dispose() {
    disposed=true;
    for(const item of pending.values()){clearTimer(item.timer);item.reject(failure('measurement_controller_closed'));}
    pending.clear();
  }
  return {request,handleMessage,dispose};
}
