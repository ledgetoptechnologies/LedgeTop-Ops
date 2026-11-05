# LT Ops iPhone pilot

Native SwiftUI pilot for iOS 17 and newer. This is a separate application in the
existing LedgeTop-Ops repository, on branch `codex/lt-ops-ios-pilot-client`.

Working folder: `C:\Projects\Ledge Top Operations\ios-pilot-client\apps\ios-pilot`.
The sibling `Operations` checkout remains untouched. A Git worktree provides a
separate folder for this branch while sharing the repository history; it is not
a second unrelated repository. Merge only after review and device validation.

## What you can try

- Today: operation and open-task counts, job summaries, and progress.
- Operations: case-insensitive search by job/client/service/site and status filter.
- Details: operation brief, session-only checklist toggles, and delivery preview.
- Pilot: explicit offline status and reset demo workspace.

All three sample clients and training sites are fictional. Refresh/reset restores
the samples; task changes are intentionally not saved between app launches. The
app starts in Demo. No flight clearance is inferred from a checklist.

## Read-only connection (staging activation in progress)

The Pilot tab has separate demo and managed-Access sign-in paths. The iPad has
successfully completed the synthetic Cloudflare sign-in test, including an
Access identity match. That test returns no business data. The read-only backend
and isolated staging Worker configurations are in review. Resource origins are
fixed in source; the default `Info.plist` still selects only the staging
diagnostic. Live mode requires the separately accepted backend deployment.
See [BACKEND-ROLLOUT.md](BACKEND-ROLLOUT.md) for the remaining gates.

The managed build selects a fixed resource using `LTOpsEnvironment`; it never
accepts a user-entered URL. The production host is a source candidate, not proof
that an Access application, policy, database binding or release is approved.

| Build | Environment | Live | Synthetic probe | Production flag |
| --- | --- | --- | --- | --- |
| Default diagnostic | `staging` | false | true | false |
| Accepted staging reads | `staging` | true | false | false |
| Separately accepted production reads | `production` | true | false | true |

The flags are `LTOpsLiveEnabled`, `LTOpsSyntheticProbeEnabled`, and
`LTOpsProductionPilotEnabled`. Unknown/missing environment, mixed modes,
production probe mode and inconsistent production flags configure no network
client. Changing a build flag never changes server permissions or constitutes
release approval. The legacy `LTOpsOrigin` key does not select managed OAuth.

The flow uses `ASWebAuthenticationSession`, OS-generated state and PKCE S256,
and the registered custom callback
`com.ledgetoptechnologies.ops.pilot://auth/callback`. There is no user-entered
origin. Business records and refresh grants stay in memory. The wired restart
flow can save only a bounded access token in device-only Keychain storage;
restoration verifies staff access online and fetches records again. Requests use ephemeral
sessions without cookies, disk cache, or redirects. Sign-out clears local access
immediately and reports when Cloudflare revocation cannot be confirmed. The
browser's separate SSO session may remain signed in.

The live screen has no checklist toggles, edits, delivery controls, or files.
It preserves server statuses and displays only supplied fields. Counts and
search describe **loaded records**, with explicit Load more pagination; they
are not global dashboard totals. Permission failures and session expiry clear
the displayed data. A failed live request never silently switches to demo.
Generation guards prevent responses from a cancelled sign-in, old detail view,
or signed-out session from restoring data.

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

This checks demo behavior plus callback validation, fixed-origin configuration,
pagination/deduplication, expiry, and fail-closed API responses. On Linux and
macOS `os(iOS)` excludes the UI: a passing
Linux test run does **not** establish that the iPhone app compiles or renders.
Run the Xcode/xtool build and the following checks before calling device QA done:

1. Launch and verify the demo banner on Today, Operations, and details.
2. Search `cedar`; change status to Ready for delivery and verify the empty state.
3. Toggle North field's second task; verify progress and Today open-task count.
4. Reset in Pilot; verify the original checklist returns.
5. Check large Dynamic Type, dark mode, VoiceOver labels, and portrait/landscape.
6. Disable networking; verify all demo flows still work.

Before enabling the live pilot, also verify on the actual iPad:

1. Access browser sign-in returns to this app and an intercepted code cannot be redeemed without its verifier.
2. Cancel sign-in and sign out during each in-flight stage; no data reappears.
3. Session expiry, staff revocation, and removed source/division access clear or deny data.
4. Only approved synthetic staging operations are visible; two-source IDs remain distinct.
5. Load more and refresh do not imply global totals or retain inaccessible rows.
6. Failed sign-in/offline refresh shows an error without replacing live data with samples.

Local Swift tests and iOS-target syntax parsing do not prove a native build,
successful Cloudflare sign-in, or device acceptance. The read-only code has not
been installed over the working demo. GitHub Actions must remain main-only;
feature-branch validation is local. See [backend pilot release notes](BACKEND-ROLLOUT.md) for
the separate Access-routing, schema, and deployment prerequisites.

## App icon for xtool device builds

The icon uses the LT Ops mark from `apps/operations/public/favicon.svg`. Xcode
compiles `Resources/Assets.xcassets` automatically. For the Linux xtool device
build, copy the catalog and `prepare-ipad-icon.sh` to the Linux build copy, run
`xtool dev build` (without `--sign`), then run `bash prepare-ipad-icon.sh` from
that copy before `xtool install`. The installer signs the completed bundle.
Adding assets after signing would invalidate the signature. Build and install
using the existing app identifier so this updates the existing pilot.
