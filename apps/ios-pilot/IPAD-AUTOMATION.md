# Physical iPad automation investigation

October 30, 2026. This is research, not an installed or validated automation
system. Beau wants the pilot tested on his iPad while he is away.

Appium documents limited Windows/Linux support for real iPadOS 18+ devices
using RemoteXPC and an already installed or externally running WebDriverAgent
(WDA). The iPad runs iPadOS 26; the Windows PC detects it over USB. Current
Appium WDA release 16.15.3 contains a runner with both iPhone and iPad device
families, but its nested XCTest bundle needs correct signing. The installed
xtool can sign and install the pilot app; inspection of its signer and
provisioning code does not establish correct nested XCTest provisioning and
entitlements. Do not treat successful outer-app installation as evidence that
WDA can launch or send touch input.

Before a device experiment, establish a reviewed nested-signing and provisioning
approach, pin and verify upstream artifacts, confirm Developer Mode and device
pairing, and bind automation services to a controlled local interface. Some
third-party workflows forward unauthenticated control ports on all interfaces;
do not start them with those defaults. Do not store the device passcode or
expose Apple credentials. Keep the existing LT Ops pilot and avoid creating
unnecessary duplicate apps. Track and stop task-owned services when finished.

A free Apple account can sign WDA manually according to Appium's guidance, but
the free provisioning profile expires and needs periodic renewal. Whether this
specific Windows signing path works on Beau's iPad is unverified. Device unlock,
Apple sign-in and any trust/authorization prompts may require Beau's help.

References: [Appium non-macOS hosts](https://appium.github.io/appium-xcuitest-driver/latest/guides/non-macos-hosts/),
[Appium device provisioning](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/provisioning-profile/index.md),
and [WebDriverAgent releases](https://github.com/appium/WebDriverAgent/releases).
