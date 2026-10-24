import { deploymentSourceCommit } from './production-deploy.mjs';

const REPO = 'ledgetoptechnologies/LedgeTop-Ops';
const SHA = /^[a-f0-9]{40}$/u;
export const REQUIRED_MAIN_JOBS = Object.freeze(['source-invariants','incoming-pickup-alpine','client','operations','ops-sync','thumbnail-renderer',
  'operations-browser-desktop-edge','operations-browser-mobile-edge','client-browser-desktop-edge','client-browser-mobile-edge'].sort());
const need = ok => { if (!ok) throw Error('Exact successful main CI is required; automatic release held'); };
/** Read only. Fixed official repository/URLs, bounded bodies, no redirect or
 * retry, and no raw provider errors/headers in release receipts. This is not an
 * inbox poller. A CI-completion event should start the deployment; Workers
 * Builds has a20-minute timeout, so waiting there for the entire CI is unsafe.
 * https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ */
export class ProductionMainCI {
  #token;
  constructor({fetchImpl=fetch, token, timeoutMs=30_000}={}) {
    need(typeof fetchImpl==='function' && Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30_000
      && (token===undefined || typeof token==='string' && /^[A-Za-z0-9_-]{20,1024}$/u.test(token)));
    this.fetch=fetchImpl;this.#token=token;this.timeoutMs=timeoutMs;
  }
  async get(suffix) {
    need(typeof suffix==='string' && /^\/(?:commits\/main|actions\/workflows\/ci\.yml\/runs\?branch=main&event=push&head_sha=[a-f0-9]{40}&per_page=100|actions\/runs\/[1-9][0-9]*\/jobs\?filter=latest&per_page=100)$/u.test(suffix));
    let response,reader,timer;const controller=new AbortController();const signal=controller.signal;
    const cancel=()=>{try{void reader?.cancel().catch(()=>{});}catch{}};
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(Error('CI deadline'));},this.timeoutMs);});
    const operation=(async()=>{
      response=await this.fetch(`https://api.github.com/repos/${REPO}${suffix}`,{method:'GET',redirect:'error',signal,
        headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
          ...(this.#token?{Authorization:`Bearer ${this.#token}`}:{})}});
      need(response instanceof Response && response.status===200 && !response.redirected && !response.headers.has('Location')
        && !response.headers.has('Link') && response.headers.get('Content-Type')?.split(';')[0]==='application/json');
      signal.throwIfAborted();reader=response.body?.getReader();need(reader);let length=0;const chunks=[];
      for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;length+=part.value.length;need(length<=5*1024*1024);chunks.push(Buffer.from(part.value));}
      signal.throwIfAborted();const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));need(body&&typeof body==='object');return body;
    })();
    try {return await Promise.race([operation,deadline]);}
    catch {throw Error('Exact main CI read failed; automatic release held');}
    finally {clearTimeout(timer);cancel();try{reader?.releaseLock();}catch{}}
  }
  async mainCommit() {const body=await this.get('/commits/main');need(typeof body.sha==='string'&&SHA.test(body.sha));return body.sha;}
  async verify(sourceCommit) {
    need(typeof sourceCommit==='string' && SHA.test(sourceCommit) && await this.mainCommit()===sourceCommit);
    const result=await this.get(`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sourceCommit}&per_page=100`);
    need(Number.isSafeInteger(result.total_count)&&result.total_count>=1&&result.total_count<=100
      &&Array.isArray(result.workflow_runs)&&result.workflow_runs.length===result.total_count);
    const runs=result.workflow_runs;
    need(runs.every(r=>r&&Number.isSafeInteger(r.id)&&r.id>0&&Number.isSafeInteger(r.run_number)&&r.run_number>0&&Number.isSafeInteger(r.run_attempt)&&r.run_attempt>0));
    const run=[...runs].sort((a,b)=>b.run_number-a.run_number || b.run_attempt-a.run_attempt)[0];
    need(run.name==='CI'&&run.path==='.github/workflows/ci.yml'&&run.head_sha===sourceCommit&&run.head_branch==='main'&&run.event==='push'
      &&run.status==='completed'&&run.conclusion==='success'&&run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO);
    const jobs=await this.get(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    need(jobs.total_count===REQUIRED_MAIN_JOBS.length&&Array.isArray(jobs.jobs)&&jobs.jobs.length===jobs.total_count
      &&new Set(jobs.jobs.map(j=>j.name)).size===jobs.jobs.length&&JSON.stringify(jobs.jobs.map(j=>j.name).sort())===JSON.stringify(REQUIRED_MAIN_JOBS)
      &&jobs.jobs.every(j=>j.status==='completed'&&j.conclusion==='success'&&j.run_id===run.id&&j.head_sha===sourceCommit));
    need(await this.mainCommit()===sourceCommit);
    return Object.freeze({sourceCommit,passed:true,runId:run.id,runAttempt:run.run_attempt});
  }
}
export function cloudflareBuildSource({root,env=process.env,readSource=deploymentSourceCommit}={}) {
  need(env.WORKERS_CI==='1'&&env.WORKERS_CI_BRANCH==='main'&&SHA.test(env.WORKERS_CI_COMMIT_SHA??'')
    &&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(env.WORKERS_CI_BUILD_UUID??''));
  const sourceCommit=readSource(root,env);need(sourceCommit===env.WORKERS_CI_COMMIT_SHA);return sourceCommit;
}
