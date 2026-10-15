# Project Alpha Directory adoption staging acceptance profile

This separately reviewed Operations profile layers exactly two Directory gates
onto the approved Project Alpha API-v2 plus live Viewer candidate:

- `PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED=true`
- `PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED=true`

Both flags must remain explicitly `false` in the ordinary staging config.
Production must explicitly set exact adoption to `false`; local-profile adoption
may be omitted or use the string `"false"`. Omission is fail-closed because
`finalizer.ts` enables it only for the exact string `"true"`, and
`local-profile.ts` additionally requires `ENVIRONMENT=staging`. Null, empty,
boolean, and other production values are rejected. The generated ignored candidate preserves the composed Viewer URL,
key IDs, names-only secret inventory, resources, five API-v2 gates, and every
other default-off gate byte-for-byte. No production config change is required.

Before opening the window, record and independently review the before
nonmutation snapshot, the current native profile authority, and the exact source
identity tuple. Within the window, reserve the explicitly selected records,
compare fields, and seal the complete field decisions. Verify that sealed
receipt and the current authority again before finalization. Selection remains
explicit: this window
does not authorize automatic matching, client access, public links, or any
additional authority or portal gate.

Use the existing ignored names-only Viewer inventory; never place credential
values in config, arguments, Git, logs, or evidence. Then run:

```powershell
npm.cmd run staging:project-alpha-directory-adoption:generate
npm.cmd run staging:project-alpha-directory-adoption:check
```

Review the full diff and use only the explicit ignored output
`apps/operations/wrangler.staging.project-alpha-directory-adoption-acceptance.json`
in a separately approved staging version workflow. When the bounded Directory
window closes, restore the exact pre-window reviewed API-v2 plus Viewer config,
turning off only these two Directory gates. Do not restore the ordinary baseline.
Inspect bindings and reverify the Viewer workspace launch after restoration.
