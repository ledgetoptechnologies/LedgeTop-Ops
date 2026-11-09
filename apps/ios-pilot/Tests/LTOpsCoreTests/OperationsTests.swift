import XCTest
@testable import LTOpsCore

final class OperationsTests: XCTestCase {
    func testSearchCombinesStatusAndCaseInsensitiveClient() {
        let workspace = OperationsWorkspace(operations: DemoOperationsService.samples)
        XCTAssertEqual(workspace.matching("  CEDAR  ", status: .inProgress).map(\.id), ["demo-north"])
        XCTAssertTrue(workspace.matching("CEDAR", status: .ready).isEmpty)
        XCTAssertEqual(workspace.matching("   ").count, 3)
        XCTAssertTrue(workspace.matching("unknown client").isEmpty)
    }
    func testTaskUpdateCannotCrossOperationBoundary() {
        var workspace = OperationsWorkspace(operations: DemoOperationsService.samples)
        let initial = workspace.operations
        XCTAssertFalse(workspace.toggleTask(operationID: "demo-north", taskID: "roof-brief"))
        XCTAssertFalse(workspace.toggleTask(operationID: "unknown", taskID: "north-brief"))
        XCTAssertEqual(workspace.operations, initial)
        XCTAssertTrue(workspace.toggleTask(operationID: "demo-north", taskID: "north-access"))
        XCTAssertEqual(workspace.openTaskCount, 3)
        XCTAssertEqual(workspace.operations[0].progress, 2.0 / 3.0, accuracy: 0.001)
        XCTAssertEqual(workspace.operations[1], initial[1])
    }
    func testDemoResetDoesNotPersistTaskChanges() async throws {
        let service = DemoOperationsService()
        var workspace = OperationsWorkspace(operations: try await service.loadOperations())
        workspace.toggleTask(operationID: "demo-north", taskID: "north-access")
        let reset = try await service.loadOperations()
        XCTAssertFalse(reset[0].tasks[1].completed)
    }
}
