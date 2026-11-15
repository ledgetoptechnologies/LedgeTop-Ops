import XCTest
@testable import LTOpsCore

final class MobileBusinessTests: XCTestCase {
    private func root(source: String = "project-alpha:primary", namespace: String = "business",
                      kind: String = "organization", id: String = "root/a", name: String = "Sample company") -> MobileBusinessRoot {
        MobileBusinessRoot(sourceId: source, rootNamespace: namespace, kind: kind, clientHubRootId: id, name: name)
    }

    func testOnlyExactPrimarySourceIsAcceptedForBothBusinessKinds() {
        XCTAssertTrue(root().isValid)
        XCTAssertTrue(root(kind: "standalone_client").isValid)
        for source in ["project-alpha:staging", "project-alpha:source-2-staging", "project-alpha:other",
                       "Project-Alpha:Primary", "project-alpha:primary ", "", "primary"] {
            XCTAssertFalse(root(source: source).isValid, source)
        }
    }

    func testNamespaceKindAndBoundedRootFieldsRemainRequired() {
        XCTAssertFalse(root(namespace: "portal").isValid)
        XCTAssertFalse(root(kind: "project").isValid)
        for id in ["", ".", "..", "root\u{0}", String(repeating: "a", count: 513)] {
            XCTAssertFalse(root(id: id).isValid)
        }
        XCTAssertFalse(root(name: "").isValid)
        XCTAssertFalse(root(name: "Company\nname").isValid)
        XCTAssertFalse(root(name: String(repeating: "a", count: 513)).isValid)
        XCTAssertNotEqual(root().id, root(kind: "standalone_client").id)
        XCTAssertNotEqual(root().id, root(id: "other").id)
    }

    func testInvalidSourcePageDoesNotChangeLoadedRootsOrCursor() throws {
        var records = MobileBusinessRoots()
        try records.append(MobileBusinessRootsPage(schemaVersion: 1, roots: [root()], nextCursor: "next_page"), requestedCursor: nil)
        let previous = records.roots
        XCTAssertThrowsError(try records.append(MobileBusinessRootsPage(schemaVersion: 1,
            roots: [root(source: "project-alpha:staging", id: "other")], nextCursor: nil), requestedCursor: "next_page"))
        XCTAssertEqual(records.roots, previous)
        XCTAssertEqual(records.nextCursor, "next_page")
        try records.append(MobileBusinessRootsPage(schemaVersion: 1,
            roots: [root(kind: "standalone_client")], nextCursor: nil), requestedCursor: "next_page")
        XCTAssertEqual(records.roots.count, 2, "same root key in a different business kind is a distinct identity")
        XCTAssertNil(records.nextCursor)
    }

    func testDuplicateIdentityAndReusedCursorStillRefusePrimaryPages() throws {
        var duplicate = MobileBusinessRoots()
        XCTAssertThrowsError(try duplicate.append(MobileBusinessRootsPage(schemaVersion: 1,
            roots: [root(), root()], nextCursor: nil), requestedCursor: nil))
        var records = MobileBusinessRoots()
        try records.append(MobileBusinessRootsPage(schemaVersion: 1, roots: [], nextCursor: "page_two"), requestedCursor: nil)
        XCTAssertThrowsError(try records.append(MobileBusinessRootsPage(schemaVersion: 1,
            roots: [root()], nextCursor: "page_two"), requestedCursor: "page_two"))
        XCTAssertTrue(records.roots.isEmpty)
        XCTAssertEqual(records.nextCursor, "page_two")
    }
}
