import XCTest
@testable import LTOpsCore

final class PilotWorkspacePresentationTests: XCTestCase {
    func testStaffSessionShowsEveryTabAndLandsOnHome() {
        XCTAssertEqual(PilotWorkspacePresentation.tabs(readOnly: false, dashboard: .notOffered, tasks: .idle), PilotWorkspaceTab.allCases)
        XCTAssertEqual(PilotWorkspacePresentation.landing(requested: nil, readOnly: false), .home)
    }

    func testReadOnlyPilotShowsOnlyOfferedAreasAndLandsOnClients() {
        XCTAssertEqual(PilotWorkspacePresentation.tabs(readOnly: true, dashboard: .notOffered, tasks: .notOffered), [.operations, .clients, .more])
        XCTAssertEqual(PilotWorkspacePresentation.tabs(readOnly: true, dashboard: .idle, tasks: .idle), [.operations, .clients, .more],
                       "nothing appears before the source has said it offers it")
        XCTAssertEqual(PilotWorkspacePresentation.tabs(readOnly: true, dashboard: .current, tasks: .notOffered), [.home, .operations, .clients, .more])
        XCTAssertEqual(PilotWorkspacePresentation.tabs(readOnly: true, dashboard: .denied, tasks: .notRefreshed(.busy)), PilotWorkspaceTab.allCases,
                       "denied or temporarily failing areas are offered areas and keep their tab")
        XCTAssertEqual(PilotWorkspacePresentation.landing(requested: nil, readOnly: true), .clients)
    }

    func testAnExplicitTabRequestWinsOnlyWhenItIsARealTab() {
        XCTAssertEqual(PilotWorkspacePresentation.landing(requested: "tasks", readOnly: true), .tasks)
        XCTAssertEqual(PilotWorkspacePresentation.landing(requested: "operations", readOnly: false), .operations)
        XCTAssertEqual(PilotWorkspacePresentation.landing(requested: "admin", readOnly: true), .clients)
        XCTAssertEqual(PilotWorkspacePresentation.landing(requested: "", readOnly: false), .home)
    }

    func testAHiddenTabFallsBackToTheModesLanding() {
        let readOnlyTabs: [PilotWorkspaceTab] = [.operations, .clients, .more]
        XCTAssertEqual(PilotWorkspacePresentation.resolve(selected: .home, available: readOnlyTabs, readOnly: true), .clients)
        XCTAssertEqual(PilotWorkspacePresentation.resolve(selected: .tasks, available: readOnlyTabs, readOnly: true), .clients)
        XCTAssertEqual(PilotWorkspacePresentation.resolve(selected: .operations, available: readOnlyTabs, readOnly: true), .operations)
        XCTAssertEqual(PilotWorkspacePresentation.resolve(selected: .home, available: PilotWorkspaceTab.allCases, readOnly: false), .home)
        XCTAssertEqual(PilotWorkspacePresentation.resolve(selected: .home, available: [.more], readOnly: true), .more)
    }

    func testSourceLabelsAreExactAndUnknownIdsAreLeftAlone() {
        XCTAssertEqual(PilotWorkspacePresentation.sourceLabel("project-alpha:staging"), "Staging workspace")
        XCTAssertEqual(PilotWorkspacePresentation.sourceLabel("project-alpha:source-2-staging"), "Staging workspace 2")
        XCTAssertEqual(PilotWorkspacePresentation.sourceLabel("project-alpha:primary"), "project-alpha:primary")
        XCTAssertEqual(PilotWorkspacePresentation.sourceLabel("Project-Alpha:Staging"), "Project-Alpha:Staging", "no fuzzy matching")
        XCTAssertEqual(PilotWorkspacePresentation.sourceLabel("Ledge Top Drone Services"), "Ledge Top Drone Services")
        XCTAssertNil(PilotWorkspacePresentation.sourceLabel(nil))
        XCTAssertNil(PilotWorkspacePresentation.sourceLabel(""))
    }

    func testReadOnlyMarkerNamesTheEnvironment() {
        XCTAssertEqual(PilotWorkspacePresentation.readOnlyMarker(environment: "Staging"), "Read-only pilot · Staging data")
        XCTAssertEqual(PilotWorkspacePresentation.readOnlyMarker(environment: "  "), "Read-only pilot")
    }
}
