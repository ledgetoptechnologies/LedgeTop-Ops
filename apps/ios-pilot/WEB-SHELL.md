# Web workspace shell (hybrid app)

Hub decision e418633a chose a hybrid app: a native shell that hosts the shared
web UI, with sign-in, downloads and offline files kept native. This is the first
slice of that shell. Contract: Hub note `ledge-top-ops` /
`ui/app-web-bridge-contract-draft-20261110.md` (draft v0.2, not yet accepted).

## State

Off by default. `Info.plist` ships `LTOpsWebShellEnabled` false and an empty
`LTOpsWebShellOrigins`, so the settings row is hidden and nothing loads. No
workspace address is pinned in source: the release owner sets the exact origins
once the replacement staging host is verified.

| Piece | File | Status |
|---|---|---|
| Origin allowlist, navigation policy, bridge validation, receipts, rate limit | `Sources/LTOpsCore/WebShell.swift` | Built, package-tested |
| Web view screen and settings entry | `Sources/LTOpsPilot/WebShellView.swift` | Compiles against the Apple SDK; not yet run on a device |
| Native sign-in hand-off into the web view | none | Not built |
| Downloads, offline storage, native confirmation | none | Not built; every bridge command returns `unsupported` |

## Rules the shell enforces

- Main frame loads only exact https origins from the allowlist. Other links
  open in the system browser when the user tapped them, and are dropped otherwise.
- Any invalid allowlist entry disables the shell (no wildcards, IP addresses,
  localhost, paths or alternate spellings).
- Cloudflare Access and identity-provider pages never render in the web view.
  The shell stops and shows a native "Sign-in needed" state.
- `window.ltdsApp` is installed only in main frames, and requests are honored
  only from an allowlisted main frame. Unknown or extra fields are rejected.
- The web session is not persisted (non-persistent data store), and downloads
  from the page are cancelled, until the native pieces exist.

## Open items

1. Sign-in: how a native Access sign-in authorizes the web view without page
   script ever seeing a credential. Needs the provider owner.
2. The verified staging origin for the Ops web UI.
3. Device run on the iPad with a test allowlist.
