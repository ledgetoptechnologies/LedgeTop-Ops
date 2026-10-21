import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';

// Three's WorkerPool only resolves messages. A worker that cannot initialize
// leaves every queued texture (and its owning tile) parsing forever. Bound only
// active worker jobs, NOT queued jobs, and reject all affected parses if the
// decoder crashes. Never silently substitute uncompressed textures or widen CSP.
export function guardKtx2WorkerPool(pool, { timeoutMs = 120_000, workerObserver = null } = {}) {
  const postMessage = pool.postMessage.bind(pool);
  const setWorkerCreator = pool.setWorkerCreator.bind(pool);
  const dispose = pool.dispose.bind(pool);
  const pending = new Set();
  const cleanup = new Set();
  let failure = null;
  const observe = (stage, message) => {
    if (message?.type !== 'transcode' || typeof workerObserver !== 'function') return;
    try { workerObserver(stage, message); } catch { /* Diagnostic observers cannot fail decoding. */ }
  };
  function fail(reason) {
    if (failure) return;
    failure = new Error(reason);
    failure.code = 'ktx2_transcoder_failed';
    for (const release of cleanup) release();
    cleanup.clear();
    dispose();
    for (const request of pending) { observe('failed', request.message); request.reject(failure); }
    pending.clear();
  }
  pool.setWorkerCreator = (creator) => setWorkerCreator(() => {
    if (failure) throw failure;
    const worker = creator();
    const send = worker.postMessage.bind(worker);
    let timer;
    let activeMessage = null;
    const clear = () => { clearTimeout(timer); timer = null; };
    const onMessage = event => { clear(); observe(event?.data?.type === 'error' ? 'failed' : 'end', activeMessage); activeMessage = null; };
    const onError = () => fail('The KTX2 texture decoder worker failed to initialize or process a texture.');
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onError);
    cleanup.add(() => {
      clear();
      activeMessage = null;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onError);
    });
    worker.postMessage = (message, transfer) => {
      if (message?.type === 'transcode') {
        activeMessage = message;
        observe('start', message);
        clear();
        timer = setTimeout(() => fail('The KTX2 texture decoder did not respond before its processing deadline.'), timeoutMs);
      }
      try { return send(message, transfer); } catch (error) { onError(); throw error; }
    };
    return worker;
  });
  pool.postMessage = (message, transfer) => {
    if (failure) return Promise.reject(failure);
    observe('enqueue', message);
    return new Promise((resolve, reject) => {
      const request = { reject, message };
      pending.add(request);
      Promise.resolve().then(() => {
        if (failure) throw failure;
        return postMessage(message, transfer);
      }).then(result => {
        pending.delete(request);
        resolve(result);
      }, error => {
        if (!failure) observe('failed', message);
        pending.delete(request);
        reject(error);
      });
    });
  };
  pool.dispose = () => fail('The KTX2 texture decoder was disposed before processing completed.');
  return { dispose: () => pool.dispose() };
}

export function installLodKtx2Support(tilesRenderer, renderer, {
  KTX2LoaderClass = KTX2Loader,
  GLTFExtensionsPluginClass = GLTFExtensionsPlugin,
  transcoderPath = '/basis/',
  workerLimit = 2,
  decodeTimeoutMs = 120_000,
  workerObserver = null,
} = {}) {
  const loader = new KTX2LoaderClass()
    .setTranscoderPath(transcoderPath)
    .setWorkerLimit(workerLimit)
    .detectSupport(renderer);
  if (loader.workerPool) guardKtx2WorkerPool(loader.workerPool, { timeoutMs: decodeTimeoutMs, workerObserver });
  const plugin = new GLTFExtensionsPluginClass({ ktxLoader: loader, autoDispose: false });
  tilesRenderer.registerPlugin(plugin);
  let disposed = false;
  return {
    loader,
    plugin,
    dispose() {
      if (disposed) return;
      disposed = true;
      loader.dispose();
    },
  };
}
