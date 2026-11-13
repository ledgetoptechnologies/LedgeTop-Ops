// Synthetic Git-data transport for composing the real release runtime and journal.
// It performs no network I/O and enforces the same non-forced parent CAS used by
// the journal. Unsupported requests are left to the surrounding protocol fixture.
export function createJournalGitHttp(commits, { journals = [] } = {}) {
  const prefix = '/repos/ledgetoptechnologies/LedgeTop-Ops';
  const api = `https://api.github.com${prefix}`;
  const refs = new Map(), objects = new Map(), trees = new Map(), blobs = new Map(), requests = [];
  let serial = 1;
  const initialTree = 'f'.repeat(40);
  trees.set(initialTree, { tree: [] });
  for (const sha of commits) objects.set(sha, { sha, tree: { sha: initialTree }, parents: [] });
  const next = () => (serial++).toString(16).padStart(40, '0');
  for (const { workerName, head, bytes } of journals) {
    const blob = next(), tree = next();
    blobs.set(blob, Buffer.from(bytes));
    trees.set(tree, { tree: [{ path: 'production-auto-journal.json', type: 'blob', mode: '100644', sha: blob }] });
    objects.set(head, { sha: head, tree: { sha: tree }, parents: [] });
    refs.set(`ltds-production-auto-journal-${workerName}`, head);
  }
  const response = (status, value, location) => Response.json(value, {
    status, headers: location ? { Location: api + location } : {},
  });
  return { requests, refs, async fetch(url, init = {}) {
    const parsed = new URL(url), method = init.method ?? 'GET';
    if (parsed.origin !== 'https://api.github.com' || !parsed.pathname.startsWith(`${prefix}/git/`)) return null;
    const path = parsed.pathname.slice(prefix.length), body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, path });
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
      const name = path.slice('/git/ref/heads/'.length);
      return refs.has(name) ? response(200, { ref: `refs/heads/${name}`, object: { sha: refs.get(name) } }) : response(404, null);
    }
    if (method === 'POST' && path === '/git/blobs') {
      const sha = next(); blobs.set(sha, Buffer.from(body.content, 'base64'));
      return response(201, { sha }, `/git/blobs/${sha}`);
    }
    if (method === 'POST' && path === '/git/trees') {
      const sha = next(); trees.set(sha, { tree: body.tree });
      return response(201, { sha }, `/trees/${sha}`);
    }
    if (method === 'POST' && path === '/git/commits') {
      const sha = next(); objects.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents });
      return response(201, { sha }, `/git/commits/${sha}`);
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = body.ref.replace(/^refs\/heads\//u, '');
      if (refs.has(name)) return response(422, {});
      refs.set(name, body.sha);
      return response(201, { object: { sha: body.sha } }, `/git/refs/heads/${name}`);
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
      const name = path.slice('/git/refs/heads/'.length), current = refs.get(name);
      if (!current || body.force !== false || objects.get(body.sha)?.parents?.[0] !== current) return response(422, {});
      refs.set(name, body.sha); return response(200, { object: { sha: body.sha } });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) return objects.has(path.split('/').at(-1))
      ? response(200, objects.get(path.split('/').at(-1))) : response(404, null);
    if (method === 'GET' && path.startsWith('/git/trees/')) return trees.has(path.split('/').at(-1))
      ? response(200, trees.get(path.split('/').at(-1))) : response(404, null);
    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const bytes = blobs.get(path.split('/').at(-1));
      return bytes ? response(200, { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length }) : response(404, null);
    }
    throw Error('unexpected synthetic Git journal route');
  } };
}
