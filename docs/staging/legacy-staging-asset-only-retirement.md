# Legacy staging (production account): asset-only retirement plan

This is a plan and source candidate only. Nothing here deploys anything. Merger owns every provider read and
write, the cutoff and pruning. Scope: the three core legacy staging Workers in the production account
`846c924bf17bf4f3dd15c97a4c5d1d51` that are still preserved:

| Worker | Installed version | Named exports (Merger readback) | Asset bindings |
|---|---|---|---|
| `ledgetop-ops-staging` | `3c4de3e4-c70f-4288-8eb6-59c7f288b89d` | 20: 1 Durable Object, 5 Workflow, 11 RPC entrypoint, 3 plain functions | `ASSETS` |
| `ledgetop-clients-staging` | `75032d02-41ce-426d-9e8b-097fbe290b0d` | 31: 2 Workflow, 11 RPC entrypoint, 18 plain functions | `ASSETS`, `UI_RELEASE_ASSETS` (service → `ledgetop-ui-assets-staging`) |
| `ledgetop-ui-assets-staging` | `b4d6f534-d2a2-4d08-8da6-9d3fcfd1a3c3` | default `fetch` only | `ASSETS` |

The goal, per Beau, is that legacy staging in the production account is retired:
- no new HTML, app, API or RPC traffic is admitted;
- only the verified retained static files stay served, byte-exact, for at least 48 h after cutoff;
- Durable Object, Workflow, D1 and R2 state is untouched;
- there are no cron, queue or other side effects.

## What the facade does (source: `scripts/legacy-staging-retirement/`)

`generate.mjs <spec.json> <out-dir>` writes a single-module Worker (`index.mjs`, whose only import is
`cloudflare:workers`) and a `receipt.json`. The spec comes only from Merger's read-only readback of the installed
version, never from app source (the installed Ops source `7c1e48d9` isn't an ancestor of main):

```json
{ "worker": "ledgetop-ops-staging", "installedVersionId": "3c4de3e4-…", "bindings": ["ASSETS"],
  "exports": [{ "name": "ThumbnailRendererContainer", "kind": "durable_object" }, { "name": "R2CrudWorkflow", "kind": "workflow" },
              { "name": "ClientDelegatedShareSigner", "kind": "entrypoint" }],
  "files": [{ "path": "/assets/app-1a2b.js", "size": 123, "sha256": "…", "mime": "text/javascript", "binding": "ASSETS" }] }
```

**Allowed requests.** The facade answers only GET and HEAD for an exact allowlisted path with no query string. It
asks that file's own binding (`ASSETS`, or `UI_RELEASE_ASSETS` for the Client's delegated UI-release files) with a
clean GET. It serves the file only if the response is 200, the pinned MIME type, and exactly the pinned length and
SHA-256. Anything else from upstream gets a 502 and the upstream body is discarded.

**Everything else gets a fixed 410 before any binding is called.** That covers:
- `/` and `/index.html`;
- any `.htm`/`.html` path, `text/html` and `application/xhtml+xml`;
- SPA and app routes, the API and unknown paths;
- query strings, userinfo, and methods other than GET/HEAD.

**The old SPA fallback can't run.** The policy validator refuses HTML or shell entries in the allowlist, and the
assets binding is never asked for a path that isn't allowlisted.

**Inert exports keep the exact names, and only the kinds stated in the spec.**
- `durable_object`: a `DurableObject` whose `fetch` returns 410 and whose `alarm` does nothing.
- `workflow`: a `WorkflowEntrypoint` whose `run` throws `worker_retired` at once.
- `entrypoint`: a `WorkerEntrypoint` with `fetch` returning 410 and no RPC methods.

Plain function exports are dropped, because no binding references them. The generator never infers a kind:
`named_handlers` also lists plain functions, so each kind must come from Merger's ownership proof against the
installed bundle.

**Default export is `{ fetch }` only.** There are no `scheduled`, `queue` or `email` handlers.

## Gates Merger runs before any provider write

1. **Freeze producers and consumers first.** A facade without a `queue` handler doesn't detach a consumer.
   - Remove the `THUMBNAIL_QUEUE` (`ltds-thumbnail-jobs-staging`) consumer.
   - Remove any R2 event notifications and other producers that target these Workers.
   - Keep the 10 crons stopped. The facade has no `scheduled` handler, but the trigger list must stay empty.
2. **Prove the installed version.** For each worker, from the exact installed version (not `latest`, which can
   differ from active), read:
   - the main-module named exports and each class's kind, checked against the DO, Workflow and service binding
     ownership;
   - the full binding list, to be carried unchanged (`keep_bindings` by type, or the explicit list);
   - the assets config. Neither the version nor the latest-settings API returns it today, so this is still an
     open proof and must not be assumed.
3. **Build the retained manifest and byte-verify it.**
   - Take the installed asset manifest/ledger for `ASSETS` and, for the Client, the `UI_RELEASE_ASSETS` paths it
     delegates.
   - Drop every HTML and shell entry; the generator refuses them anyway.
   - Read every remaining path's actual bytes through the same association, pre-change, and record size and
     SHA-256. Those values go into `spec.files`.
4. **Generate and review independently.** Run `generate.mjs`, pin `facadeSha256` and `policySha256` from
   `receipt.json`, and get an independent review of the generated `index.mjs` and the spec before any write.
5. **Upload.** Use the same script name, the same bindings, `keep_assets: true` (no old completion token is
   replayed) and assets config `run_worker_first: true`. Confirming `not_found_handling`/`html_handling: "none"`
   is part of gate 2. ASSETS serves only the current version's assets and never searches older versions, so
   `keep_assets` is what keeps the previous upload's bytes attached. Byte proof still comes from gates 3 and 6,
   not from that flag.
6. **Post-change readback, against the same association.**
   - Every allowlisted path returns the pinned bytes.
   - `/`, `/index.html`, an SPA route, an API route and a query-string path all return 410.
   - The DO namespace, Workflow definitions, D1 databases and R2 buckets are unchanged, with no migration or state
     deletion.
7. **Cutoff receipt.** `completeReceipt(receipt, cutoffIso)` sets `cutoffAt` and `earliestPruningAt = cutoff + 48 h`.
   Nothing is pruned before that, and pruning is a separate, reviewed step.

## Open points that need Merger's qualification

- **`ThumbnailRendererContainer`.** This class was a Container-backed DO. Merger must confirm that an inert
  `DurableObject` class under the same name, with the container application detached or left unused, keeps the
  namespace and its storage without migration.
- **Workflows.** In-flight instances will error on resume. Confirm none are running, or accept that they fail
  closed.
- **Client `UI_RELEASE_ASSETS`.** It stays bound to `ledgetop-ui-assets-staging`, which gets the same facade with
  its own allowlist. Retire the Client and UI-assets workers together so delegated paths stay byte-exact.
- **`ledgetop-ops-sync-staging` and the other legacy Workers** are out of this plan's scope.

## Checks (light)

`node --test scripts/legacy-staging-retirement.test.mjs` covers these cases:
- allowlisted bytes from each binding, and HEAD;
- 410 without a binding call for `/`, `/index.html`, SPA, API, unknown, query, POST/DELETE, `..` and case-variant
  paths;
- 502 for upstream 404, an HTML or wrong MIME type, and wrong bytes or a wrong hash;
- policy refusals for HTML, shell, unsafe and encoded paths, unknown bindings, duplicates and oversize files;
- the generated module running with a `cloudflare:workers` stand-in, checking exact inert exports and a `fetch`-only
  default with no RPC methods;
- receipt hashes and `+48 h`.
