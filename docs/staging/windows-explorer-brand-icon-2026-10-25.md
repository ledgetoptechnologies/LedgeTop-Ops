# Explorer navigation branding

New Explorer root generations use the existing Operations `public/favicon.ico`
unchanged (SHA-256 `4475e1abc388373b2e6c77b91e229e55e65b4efa1435e5aa816056873ad30e36`).
It is embedded in the Explorer assembly and materialized at a digest-addressed
`.ico` path under `%LOCALAPPDATA%\LedgeTopFiles\Branding`, outside portable
download and installed-package version directories. An existing file must match
the exact length and digest; unexpected bytes, directory replacements and aliases
are refused without overwriting. This shared public icon grants no root ownership.
Start/reconnect verifies or restores the known asset. Removal does not repair or
read its bytes: exact registered icon path, root/context, namespace and file ID
still prove ownership, so deleting or changing the public icon cannot block cleanup.

Schema-2 generated and schema-3 connected profiles retain their original exact
icon receipt. Existing `shell32.dll,3` registrations remain recoverable and
removable; they are not silently changed. To replace an existing yellow-folder
entry, use Settings → **Remove this connection** (or **Remove Explorer preview**
in the generated demo), then connect
again. Removal preserves existing local files; reconnect creates a new root
generation and may select a different folder rather than adopting the retained
old folder. Copy any needed local edits deliberately after checking their destination.

No speculative repeat registration or direct registry edit performs an in-place
icon migration. Microsoft's supported `StorageProviderSyncRootManager.Register`
documentation describes registration and disallows duplicate paths; it does not
establish a crash-safe metadata-only icon update contract:
https://learn.microsoft.com/en-us/uwp/api/windows.storage.provider.storageprovidersyncrootmanager.register

Focused validation: build `ExplorerTests` with isolated artifacts, then run
`--branding-policy-tests`. It checks actual embedded bytes, durable reuse,
tamper/type rejection and exact old/new icon acceptance in real schema-2/3 profile
deserialization. It creates no Windows registrations and does not operate desktop UI.
