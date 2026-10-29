# Pilot verification — October 28, 2026

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
