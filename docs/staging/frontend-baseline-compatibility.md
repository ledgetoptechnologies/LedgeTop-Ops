# Frontend baseline compatibility receipt

The production profile remains locked to sourceBase `159ba84253e7156b10e3564449c4e3d15cbf64f4` and frontend fingerprint `636f86a871ab4a8d2e99d8b71471397ae9c473d947231385e56ed4f87ba7994c`.

An exact Git archive of that revision compared with clean `43f31609960af14b060964b1ca53d875f4d9eac2` has only one fingerprinted input difference: root `package.json` adds `viewer:check` and `viewer:build` scripts. Root has no dependencies/workspaces; both frontend builds invoke their app-local Vite with unchanged app manifests and locks. No source, app lock, root lock, public file or Vite config changed.

Both revisions were built independently on Node 24.16.0 after `npm ci` in each app. Complete `dist/client` inventories include hidden files, source maps, HTML, and public assets. Sorted lexical `[relativePath, size, SHA256]` tuples were encoded with the adapter canonical JSON function. Both revisions produced identical inventories:

| App | Files | Inventory SHA256 |
| --- | ---: | --- |
| Client | 22 | `7eeaac3f977a85e6553a92b985ec1ca568c4e266a2200a8e4b6a41e4f79d1934` |
| Operations | 238 | `45adc863cfe178963df5ea23fb11451f14816ccc949962365fe9bf9efac0646f` |

The adapter admits only the exact reviewed LF-normalized root manifest hash `f8eb91b8e39b62df7d7a13b6474f96297e05110c443899c1b109fa2a0062a1d0` as baseline hash `3c5cf8119ffa8eb65d2216db89a583ba79b91a7ada75cbae8aec0856af59ae31`. It does not strip script keys, ignore dependencies, omit files, repin the profile, or enable UI uploads. Other manifest bytes, app manifests, shared source and all other inputs remain fully fingerprinted. Negative tests cover alternate scripts, dependencies and paths.

This proves the reviewed source difference leaves browser build bytes unchanged. It does not prove a complete historical live asset inventory; the backend adapter continues preserving the entire existing opaque asset association and refusing UI mode. Source compatibility does not authorize a production scalar/resource change. Domain settings require a separate exact live profile review and acceptance.

## Viewer controller compatibility (PR #243)

The separately reviewed candidate `a045e30fff179e015febbd920da46550a9cf96e8` changes `packages/shared/src/viewer-service.ts` normalized SHA `a7f1b2160fb85c06d99213edbc4ef69c0df8f0e96de6284b7d312c2520f91b0f` to `075afdc83aee2c288a10be47441e1fd7cf141edfc8a2c9936ba7102d005024b6`. Its runtime additions are server grant DTO fields and the server-side `createAdminGrant` method. Neither app browser graph imports a runtime export declared in this file; client references are type-only. The emitted browser JavaScript contains no `createAdminGrant` symbol.

Independent locked builds against `43f31609` show all non-map assets byte-identical (15 Client and 123 Ops files). Complete output trees are **not** identical: `assets/ClientPortalApp-BP54OytM.js.map` and `assets/index-Raqyjyww.js.map` each grow by 204 bytes because `sourcesContent` embeds the changed shared source. Every other map key, including mappings, and every other asset is identical. Adjacent JSON receipts record the complete comparison counts and digests.

The second finite exact-path/SHA alias admits this reviewed worker source only. Backend deployment must retain the entire existing opaque browser asset association, including its old maps. It never uploads the new maps or enables UI mode. The compatibility exception does not generalize to other DTO changes, arbitrary shared files or ignoring source maps. Any later byte difference requires another review. CI and the exact live resource/scalar review remain mandatory.
