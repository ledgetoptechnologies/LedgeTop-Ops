export function createMeasurementStore({ token, accessGeneration = () => 0, fetcher = fetch, changed = () => {}, beforeUnauthorized = () => {} }) {
  const records = new Map(), statuses = new Map(), tombstones = new Set();
  let queue = Promise.resolve(), enabled = false, persistenceAllowed = null, generation = 0, invalidated = false, authenticated = !!token();
  const pending = new Set();
  const unavailable = () => Object.assign(new Error('Private measurement access changed. Reload saved measurements after signing in again.'), {status:403,code:'measurement_access_changed'});
  function invalidate() {
    generation++;invalidated=true;enabled=false;persistenceAllowed=null;
    records.clear();statuses.clear();tombstones.clear();
    for(const controller of pending)controller.abort();pending.clear();
    // An obsolete request must not block a new identity's explicit reload.
    queue=Promise.resolve();changed();
  }
  function check(expected, {allowReload=false}={}) {
    if(expected!==generation || (invalidated&&!allowReload))throw unavailable();
    if(authenticated&&!token()){invalidate();throw unavailable();}
  }
  const bodyOf = record => Object.fromEntries(['id','name','collection','kind','vertices','coordinateReference','visible','source','results','displayPreferences','revision'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]]));
  const geometryOf = record => JSON.stringify([record.collection,record.kind,record.vertices,record.coordinateReference,record.source]);
  const conflict = () => Object.assign(new Error('This measurement changed or was deleted. Reload saved measurements before editing again.'), {status:409});
  async function request(path, method = 'GET', body, expected=generation) {
    check(expected,{allowReload:true});
    const credential = token();
    const requestedAccessGeneration = accessGeneration();
    if (!credential) throw new Error('Personal saving requires an authenticated Viewer session.');
    authenticated=true;
    const controller=new AbortController();pending.add(controller);
    try {
      const response = await fetcher(`/api/v1/measurements${path}`, {method,cache:'no-store',credentials:'same-origin',signal:controller.signal,headers:{Authorization:`Bearer ${credential}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      check(expected,{allowReload:true});
      if(response.status===401||response.status===403){
        // A successful same-person renewal may retain the bearer string. An
        // earlier request's denial must not revoke that newly verified access.
        if(requestedAccessGeneration!==accessGeneration())throw Object.assign(new Error('Access was renewed while this request was pending. Retry this measurement action.'),{status:response.status,code:'measurement_obsolete_access'});
        // Checkpoint before clearing only for an unauthenticated response. The
        // session controller additionally requires a locally expired session;
        // 403/revocation never uses this recovery path. Denial still fails closed.
        if(response.status===401)try{beforeUnauthorized();}catch{}
        invalidate();throw unavailable();
      }
      const result = response.status === 204 ? {} : await response.json();
      check(expected,{allowReload:true});
      if(!response.ok) { const error=new Error(response.status===409?'This measurement changed in another tab. Reload saved measurements before editing again.':result.error||'Measurement request failed.');error.status=response.status;throw error; }
      return result;
    } finally {pending.delete(controller);}
  }
  function enqueue(run) {
    const next=queue.then(run);queue=next.catch(()=>{});return next;
  }
  function schedule(id, run) {
    const expected=generation;
    try{check(expected);}catch(error){return Promise.reject(error);}
    statuses.set(id,'Saving…');changed();
    return enqueue(async()=>{
      try{check(expected);await run(expected);check(expected);if(records.has(id))statuses.set(id,enabled?'Saved':'Temporary — resets on refresh');else statuses.delete(id);changed();}
      catch(error){if(expected===generation&&!invalidated){statuses.set(id,`Not saved: ${error.message}`);changed();}throw error;}
    });
  }
  async function persist(record,expected) {
    check(expected);
    if(tombstones.has(record.id))throw conflict();
    const previous=records.get(record.id);
    // Never silently replace a caller's stale revision with the latest one.
    // Doing so turned delayed saves/calculations into lost updates.
    if((record.revision!==undefined||previous?.revision!==undefined)&&record.revision!==previous?.revision)throw conflict();
    if(!token()||persistenceAllowed===false){records.set(record.id,structuredClone(bodyOf(record)));return;}
    const payload=structuredClone(bodyOf({...record,...(previous?.revision?{revision:previous.revision}:{})}));
    records.set(record.id,payload);
    const response=await request(previous?.revision?`/${encodeURIComponent(record.id)}`:'',previous?.revision?'PUT':'POST',payload,expected);
    check(expected);
    records.set(record.id,response.measurement);enabled=true;
  }
  return {
    records, statuses,
    invalidate,isInvalidated:()=>invalidated,
    persistent:()=>enabled,
    load() {
      const expected=generation;
      return enqueue(async()=>{
        check(expected,{allowReload:true});
        if(!token()) { enabled=false;changed();return; }
        const responses=await Promise.all(['spatial3d','map'].map(c=>request(`?collection=${c}`,'GET',undefined,expected)));
        check(expected,{allowReload:true});
        records.clear();statuses.clear();tombstones.clear();
        for(const result of responses) for(const record of result.measurements) {records.set(record.id,record);statuses.set(record.id,'Saved');}
        persistenceAllowed=responses.every(r=>r.capabilities?.personalPersistence!==false);
        enabled=persistenceAllowed;invalidated=false;changed();
        return responses.find(r=>r.notice)?.notice;
      });
    },
    save(record) {
      const snapshot=structuredClone(record);
      return schedule(record.id,expected=>persist(snapshot,expected));
    },
    patch(record, fields) {
      // UI field edits are serialized, not full stale snapshots. Validate the
      // caller now; merge only these explicit fields at execution time against
      // the last acknowledged revision. Server 409 remains authoritative for
      // edits made in another tab. Geometry/results keep strict save semantics.
      const current=records.get(record.id);
      if(!current||tombstones.has(record.id)||current.revision!==record.revision)return Promise.reject(conflict());
      const changes=structuredClone(fields);
      if(Object.keys(changes).some(key=>!['name','visible','displayPreferences'].includes(key)))return Promise.reject(new Error('Unsupported measurement field patch.'));
      return schedule(record.id,expected=>{
        const latest=records.get(record.id);
        if(!latest||tombstones.has(record.id))throw conflict();
        return persist({...latest,...changes},expected);
      });
    },
    attachResults(record, results) {
      const snapshot=structuredClone(record),calculated=structuredClone(results);
      return schedule(snapshot.id,async expected=>{
        const current=records.get(snapshot.id);
        if(tombstones.has(snapshot.id)||!current||current.revision!==snapshot.revision||geometryOf(current)!==geometryOf(snapshot))throw conflict();
        // Merge results only. Never revive deleted records or restore an old
        // name, visibility, source or set of vertices from a dialog snapshot.
        await persist({...current,results:calculated},expected);
      });
    },
    remove(id) {
      try{check(generation);}catch(error){return Promise.reject(error);}
      tombstones.add(id);
      return schedule(id,async expected=>{const record=records.get(id);if(!record)return;if(token()&&persistenceAllowed!==false&&record.revision)await request(`/${encodeURIComponent(id)}`,'DELETE',{revision:record.revision},expected);check(expected);records.delete(id);statuses.delete(id);});
    },
  };
}
