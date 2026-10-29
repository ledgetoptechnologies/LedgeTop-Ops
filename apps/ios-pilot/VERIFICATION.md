# Pilot verification record

## Read-only client source — October 29, 2026

Worktree: `C:\Projects\Ledge Top Operations\ios-pilot`, branch
`codex/lt-ops-ios-pilot`. This receipt covers the **new client code**, not a
deployment or replacement of the previously installed and user-tested demo.

The following local command passed all **12 XCTest tests**, zero failures and no
compiler warnings, using Swift 6.0.3 in the official `swift:6.0` Docker image:

```powershell
docker run --rm --name lt-ops-ios-core-readonly --mount 'type=bind,source=C:\Projects\Ledge Top Operations\ios-pilot\apps\ios-pilot,target=/src' -w /src swift:6.0 swift test
```

Coverage: three existing demo tests plus exact-origin activation, strict callback
state/code validation, pagination/deduplication/loop rejection, optional fields
and unknown statuses, local token expiry, request headers and opaque cursor
encoding, and HTTP 401/403/HTML/redirect/wrong-schema rejection. The transport
tests use a local URLProtocol stub and do not contact live accounts or data.

This additional **syntax-only** parse succeeded with the iOS conditional code
enabled:

```powershell
docker run --rm --name lt-ops-ios-parse-readonly --mount 'type=bind,source=C:\Projects\Ledge Top Operations\ios-pilot\apps\ios-pilot,target=/src,readonly' -w /src swift:6.0 swiftc -frontend -parse -target arm64-apple-ios17.0 Sources/LTOpsPilot/LivePilot.swift Sources/LTOpsPilot/LTOpsPilotApp.swift Sources/LTOpsCore/MobilePilot.swift Sources/LTOpsCore/Operations.swift
```

Neither check typechecks SwiftUI, AuthenticationServices, or Keychain against an
Apple SDK. A native build, signing, browser callback, and live device tests are
still required. Apple SDK acquisition is currently blocked by the signed-in
Apple Developer Agreement: the owner must review/accept it in the open Edge
page. This is an account prerequisite, not a tested dependency or code failure.

The shared `Info.plist` parsed successfully with Python `plistlib`: live access
is false, the default origin is the existing staging hostname, and the fixed
custom callback scheme is registered. Xcode source references include both new
Swift files; `xtool.yml` uses its documented `infoPath` property. Client
`git diff --check` is clean. Both task-owned Docker test/parse containers exited
and were removed by `--rm`; no task-owned background client process remains.

No feature-branch GitHub Actions were invoked. No Apple session, staff token, or
client record appears in this receipt. Backend validation and deployment gates
are recorded separately; the app remains disabled by default pending those gates.

## Initial offline source verification — October 28, 2026

The following is the original source checkpoint; later demo simulator/device
verification does not establish that the new read-only client builds or signs in.

- Base: `origin/main` at `8b1ffadcdf13a9c83d4d077612fb2f30e2dae8a0`.
- Branch: `codex/lt-ops-ios-pilot`; isolated sibling worktree `ios-pilot`.
- Scope: new `apps/ios-pilot` only. Existing application and deployment files unchanged.
- `swift test` passed: 3 XCTest tests, zero failures, compiled with Swift 6.0.3
  in official Docker image `swift:6.0`, digest
  `sha256:1a1c10372d9c6c0ba9b6151085e0a26ee83a79968b3c738a47a70eac1a70bba4`.
- Tests cover search/status composition, cross-operation task isolation, progress,
  and reset behavior. Test run was repeated after independent QA fixes and passed.
- Independent static review corrected the Foundation `Operation` naming collision
  and restricted SwiftUI to iOS so core tests also remain usable on macOS.
- Shared scheme XML parsed successfully; `git diff --check` clean.
- xtool manifest reviewed against upstream `Sources/XToolSupport/NewCommand.swift`
  at observed upstream HEAD `f1b455b4c52305fb073e44f191b01c9e9db19784`.
- No SwiftUI compilation, Apple SDK build, simulator render, iPhone installation,
  signing verification, or TestFlight upload has occurred. This Windows host has
  Docker Desktop, but no configured Swift/xtool/Apple SDK development environment.
- Expo EAS Simulators access and native build compatibility remain unverified.
  The pilot contains Xcode and xtool build paths; Expo is not integrated.

The README contains reproducible build commands and the remaining manual QA steps.
