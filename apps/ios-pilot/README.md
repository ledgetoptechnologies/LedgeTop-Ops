# LT Ops iPhone pilot

Native SwiftUI pilot for iOS 17 and newer. This is a separate application in the
existing LedgeTop-Ops repository, on branch `codex/lt-ops-ios-pilot`.

Working folder: `C:\Projects\Ledge Top Operations\ios-pilot\apps\ios-pilot`.
The sibling `Operations` checkout remains untouched. A Git worktree provides a
separate folder for this branch while sharing the repository history; it is not
a second unrelated repository. Merge only after review and device validation.

## What you can try

- Today: operation and open-task counts, job summaries, and progress.
- Operations: case-insensitive search by job/client/service/site and status filter.
- Details: operation brief, session-only checklist toggles, and delivery preview.
- Pilot: explicit offline status and reset demo workspace.

All three sample clients and training sites are fictional. Refresh/reset restores
the samples; task changes are intentionally not saved between app launches. No
network calls, credentials, production data, file transfers, or access grants are
implemented. No flight clearance is inferred from a checklist. Future integration
must preserve the existing staff identity and source-qualified authorization
contracts; the `OperationsService` boundary currently offers reads only.

## Run with Xcode on a Mac

Open `LTOpsPilot.xcodeproj`, select the shared **LTOpsPilot** scheme and an iPhone
simulator, then Run. Simulator builds do not need an Apple signing team.

```sh
cd apps/ios-pilot
xcodebuild -project LTOpsPilot.xcodeproj -scheme LTOpsPilot \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
```

For a physical iPhone, set your Apple Developer team in Signing & Capabilities,
confirm an available bundle identifier (the proposed identifier is
`com.ledgetoptechnologies.ops.pilot`), enable Developer Mode when required, pair
the phone, and Run. Apple account enrollment and certificates have not been
created by this pilot. Azure Artifact Signing cannot sign this iOS app.

## Build with omarchy-apple-dev on Linux

Use the upstream [getting-started guide](https://github.com/joshuaswarren/omarchy-apple-dev/blob/main/GETTING-STARTED.md)
to install its **full** toolchain and matching Apple SDK. The experimental
no-Xcode-download mode supports only a small SwiftUI subset and is unsuitable
for this app's NavigationStack, List, and other native controls. Windows currently
needs a suitable Linux environment for this workflow; Docker Desktop's internal
WSL distribution is not a configured Omarchy development VM.

Once the full toolchain is ready, from a Linux checkout of this folder:

```sh
swift sdk list                       # confirm darwin SDK is registered
xtool dev build                     # builds xtool/LTOpsPilot.app
xtool auth                          # interactive Apple account setup
~/.local/share/omarchy-apple-dev/device-run.sh
```

Use the actual location of your omarchy checkout for `device-run.sh`. The package
uses xtool's documented single-library-product shape and its version-1
`xtool.yml`. Keep `xtool.yml` and `Pilot.xcconfig` bundle identifiers in sync if
changed. The library target imports the separate core module under SwiftPM;
Xcode compiles both source files into the application target.

Do not upload to TestFlight until a device build is tested, Apple Developer
membership is active, distribution signing is configured, and an app icon and
App Store Connect app record are supplied. This pilot is not a store release.

## Expo simulator status

[EAS Simulators](https://expo.dev/services/simulators) advertises early access
and a waitlist as checked October 28, 2026. It is a hosted service, not a second
repository to copy into this app. No access or native SwiftUI artifact support
has been verified for this account. There is no fake Expo config or claim that
an iPhone device build can run in a simulator. The Xcode command above prepares
a simulator build for a later supported host; the Linux xtool path targets a
physical device. Recheck Expo's supported upload and architecture requirements
after access is granted.

## Verification

Core behavior is platform-independent and covered with XCTest:

```sh
swift test
```

On Windows with Docker Desktop:

```powershell
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/src" -w /src swift:6.0 swift test
```

This checks search/status composition, task ownership boundaries, progress,
and reset behavior. On Linux and macOS `os(iOS)` excludes the UI: a passing
Linux test run does **not** establish that the iPhone app compiles or renders.
Run the Xcode/xtool build and the following checks before calling device QA done:

1. Launch and verify the demo banner on Today, Operations, and details.
2. Search `cedar`; change status to Ready for delivery and verify the empty state.
3. Toggle North field's second task; verify progress and Today open-task count.
4. Reset in Pilot; verify the original checklist returns.
5. Check large Dynamic Type, dark mode, VoiceOver labels, and portrait/landscape.
6. Disable networking; verify all demo flows still work.

No existing web/Worker deployment workflows were changed. This new pilot is not
connected to automatic production release. Hub update review was not claimed:
this was a new task with no exposed Hub MCP or established linked-chat checkpoint.
