// Test support only: an in-memory GitHub Git Data API for the release journal, answering like GitHub (201 + the
// documented Location on every create; trees use /repos/{o}/{r}/trees/<sha>). No network.
import { createHash } from 'node:crypto';

const REPO = '/repos/ledgetoptechnologies/LedgeTop-Ops';
const API = `https://api.github.com${REPO}`;

export function createGitHubGitFake() {
  const refs = new Map(), commits = new Map(), trees = new Map(), blobs = new Map(), requests = [];
  let serial = 1;
  const id = () => createHash('sha1').update(`object-${serial++}`).digest('hex');
  const json = (status, value, headers = {}) => new Response(value === null ? '' : JSON.stringify(value),
    { status, headers: { 'content-type': 'application/json', ...headers } });
  const created = (location, value) => json(201, value, { Location: `${API}${location}` });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET';
    if (u.origin !== 'https://api.github.com' || !u.pathname.startsWith(`${REPO}/git/`)) return null;
    const p = u.pathname.slice(REPO.length);
    requests.push({ method, path: p });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (p.startsWith('/git/ref/heads/') && method === 'GET') {
      const name = p.slice('/git/ref/heads/'.length);
      return refs.has(name) ? json(200, { ref: `refs/heads/${name}`, object: { sha: refs.get(name) } }) : json(404, null);
    }
    if (p.startsWith('/git/refs/heads/') && method === 'PATCH') {
      const name = p.slice('/git/refs/heads/'.length), current = refs.get(name), candidate = commits.get(body.sha);
      if (!refs.has(name) || body.force !== false || candidate?.parents?.[0] !== current) return json(422, {});
      refs.set(name, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    if (p === '/git/refs' && method === 'POST') {
      const name = body.ref.replace('refs/heads/', '');
      if (refs.has(name)) return json(422, {});
      refs.set(name, body.sha);
      return created(`/git/refs/heads/${name}`, { object: { sha: body.sha } });
    }
    if (p === '/git/blobs' && method === 'POST') { const sha = id(); blobs.set(sha, Buffer.from(body.content, 'base64')); return created(`/git/blobs/${sha}`, { sha }); }
    if (p === '/git/trees' && method === 'POST') { const sha = id(); trees.set(sha, { tree: body.tree }); return created(`/trees/${sha}`, { sha }); }
    if (p === '/git/commits' && method === 'POST') { const sha = id(); commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents }); return created(`/git/commits/${sha}`, { sha }); }
    if (p.startsWith('/git/commits/') && method === 'GET') {
      const sha = p.split('/').at(-1), c = commits.get(sha);
      return c ? json(200, c) : json(200, { sha, tree: { sha: 'f'.repeat(40) }, parents: [] });   // the source commit itself
    }
    if (p.startsWith('/git/trees/') && method === 'GET') { const t = trees.get(p.split('/').at(-1)) ?? { tree: [] }; return json(200, t); }
    if (p.startsWith('/git/blobs/') && method === 'GET') {
      const b = blobs.get(p.split('/').at(-1));
      return b ? json(200, { encoding: 'base64', content: b.toString('base64'), size: b.length }) : json(404, {});
    }
    return json(500, {});
  };
  /** The current journal document for a worker (parsed), or null. */
  const document = workerName => {
    const head = refs.get(`ltds-production-auto-journal-${workerName}`); if (!head) return null;
    const tree = trees.get(commits.get(head).tree.sha), entry = tree.tree.find(row => row.path === 'production-auto-journal.json');
    return JSON.parse(blobs.get(entry.sha).toString('utf8'));
  };
  return { fetchImpl, refs, commits, trees, blobs, requests, document };
}
