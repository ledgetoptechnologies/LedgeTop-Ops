# Pilot verification record

## Synthetic Cloudflare sign-in build — October 29, 2026

The app was built against the Apple SDK and signed using xtool, with only the
synthetic OAuth test enabled; real-data access remains disabled. Installation
and verification succeeded on Beau's iPad. A subsequent UI-label correction was
rebuilt and installed in place, and the device application inventory showed one
LT Ops pilot with the same existing effective bundle ID. The task-owned USB
relay was stopped. The 34 Swift package tests passed, including resource-origin
discovery and issuer-pin checks; test-stub Sendable warnings remain. Actual
Cloudflare sign-in, callback, bearer validation and sign-out are still pending
device testing.

On October 30, Beau completed Cloudflare's authorization screen but the app
reported that revocation could not be confirmed. The original failure was
overwritten by the later warning, so the failing step is unknown. A diagnostic
build preserves the step-specific failure and the separate revocation warning
without displaying codes or tokens. Swift package tests passed 35 cases, and an
Apple SDK build and signed in-place iPad installation succeeded. Device inventory
again showed one pilot app; the task-owned USB relay was stopped and verified
absent. The underlying sign-in failure remains unresolved pending the new test.

Beau's next test reached token exchange and then reported that the synthetic
connection failed with revocation unconfirmed. It did not identify the source of
the connection error. A second diagnostic update reports only fixed request and
response categories, without tokens, claims, response bodies or raw errors. The
synthetic Worker was updated to version `035577b4-7b4e-44a8-a5b7-2694584d6569`;
36 Swift package tests, 6 Worker tests and an Apple SDK signed build passed.
The updated app was installed in place, with one pilot app in the device
inventory. These checks do not establish the cause or successful sign-in.

Beau's next test reported the probe's bearer-header rejection. That check
assumed Cloudflare forwarded the original OAuth header; the observed result
does not distinguish a missing header from one with a different format. The
synthetic-only service now validates the signed Access assertion without that
assumption. Seven local probe tests passed, including absent, forged, expired,
and wrong-audience assertions. Version `22a57f6f-8792-4327-9456-086c711c94d6`
was deployed to the dedicated staging Worker; unauthenticated and fabricated
bearer requests both returned 401 at the edge. A new iPad test and revocation
verification remain pending. This result does not authorize real-data access.

Beau subsequently reported that Cloudflare sign-in and the synthetic test
succeeded. He also reported that returning to the demo was not discoverable;
the workspace now has a leading navigation button in addition to its list
action. Device verification of that navigation change remains pending. Success
on this synthetic endpoint does not establish business-data authorization or
successful provider revocation.

The navigation change passed 36 Swift package tests and a signed Apple SDK
build. The in-place iPad installer reported installing 100% but did not finish
its final verification; it was stopped after waiting. Device inventory still
listed exactly one pilot app. Whether the new button is present on the device
requires Beau's confirmation; the task-owned relay was stopped.

## Native build and installation — October 29, 2026

Commit `46790bba` was exported to a separate Linux build directory. Swift 6.4,
Xcode 27 SDK and xtool built the iOS app successfully using `xtool dev build`.
`xtool dev build --sign` succeeded and `xtool install` reported successful
installation and verification on Beau's connected iPad. Live access remains
disabled in the shipped configuration. The user has been asked to verify launch;
this receipt does not claim live sign-in, backend activation, or device acceptance.
The task-owned USB relay was stopped after installation.

Beau confirmed this build opens and shows the live-workspace option. Two pilot
copies were present because signing and installation prefixed the bundle ID
twice on the new build. With Beau's instruction to remove the old copy, the
older single-prefix demo was uninstalled; a device app listing verified that
only the double-prefix updated pilot remained. Future installs must inspect the
effective signed bundle ID first, update the existing copy, and verify that one
pilot remains; do not blindly uninstall a copy containing needed data. The
task-owned relay was stopped after this cleanup.

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
