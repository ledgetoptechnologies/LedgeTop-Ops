import XCTest
@testable import LTOpsCore

final class PilotWorkspaceModeTests: XCTestCase {
    func testEveryCombinationAndThatScopedNeverBecomesStaffWeb() {
        for live in [false, true] {
            for scoped in [false, true] {
                for web in [false, true] {
                    for configured in [false, true] {
                        let mode = PilotWorkspaceMode.select(liveEnabled: live, scopedSourceAvailable: scoped,
                                                             webShellEnabled: web, webShellConfigured: configured)
                        let label = "live=\(live) scoped=\(scoped) web=\(web) configured=\(configured)"
                        // Asking for the scoped mode rules out the staff web session, whatever else is set.
                        if live { XCTAssertNotEqual(mode, .staffWeb, label) }
                        // The scoped mode opens only when asked for and available.
                        XCTAssertEqual(mode == .scoped, live && !web && scoped, label)
                        XCTAssertEqual(mode == .staffWeb, !live && web && configured, label)
                        XCTAssertEqual(mode == .conflicting, live && web, label)
                    }
                }
            }
        }
        XCTAssertEqual(PilotWorkspaceMode.select(liveEnabled: false, scopedSourceAvailable: true,
                                                 webShellEnabled: false, webShellConfigured: true), .demo,
                       "nothing requested: the demo, even if both modes could work")
        XCTAssertEqual(PilotWorkspaceMode.select(liveEnabled: true, scopedSourceAvailable: false,
                                                 webShellEnabled: false, webShellConfigured: true), .demo,
                       "scoped requested but closed: the demo, not the staff session")
    }
}
