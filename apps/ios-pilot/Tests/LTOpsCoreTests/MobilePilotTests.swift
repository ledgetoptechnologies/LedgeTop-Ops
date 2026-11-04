import XCTest
@testable import LTOpsCore

final class MobilePilotTests: XCTestCase {
    private let state = String(repeating: "s", count: 43)
    private let code = String(repeating: "c", count: 43)
    private func page(_ ids: [String], cursor: String? = nil) throws -> MobileOperationsPage {
        let operations = ids.map { ["id": $0, "title": "Survey", "status": "Awaiting external review"] }
        var payload: [String: Any] = ["schemaVersion": 1, "operations": operations]
        payload["nextCursor"] = cursor ?? NSNull() as Any
        return try JSONDecoder().decode(MobileOperationsPage.self, from: JSONSerialization.data(withJSONObject: payload))
    }
    func testLiveConfigurationIsOptInAndExactOriginOnly() throws {
        XCTAssertThrowsError(try MobilePilotConfiguration(enabled: false, origin: "https://ops.ledgetop.app"))
        for origin in ["http://ops.ledgetop.app", "https://ops.ledgetop.app.evil.test", "https://ops.ledgetop.app/path", "https://user@ops.ledgetop.app", "https://ops.ledgetop.app/"] {
            XCTAssertThrowsError(try MobilePilotConfiguration(enabled: true, origin: origin))
        }
        let config = try MobilePilotConfiguration(enabled: true, origin: "https://ops.ledgetop.app")
        XCTAssertNoThrow(try MobilePilotConfiguration(enabled: true, origin: "https://ops-staging.ledgetopdroneservices.com"))
        let url = try config.authorizeURL(state: state, challenge: code)
        XCTAssertEqual(url.host, "ops.ledgetop.app")
        XCTAssertEqual(url.path, "/api/mobile-pilot/authorize")
        XCTAssertTrue(url.absoluteString.contains("code_challenge_method=S256"))
    }
    func testCallbackRequiresExactStateAndOnlyOneCode() throws {
        let callback = MobilePilotConfiguration.callback + "?code=\(code)&state=\(state)"
        XCTAssertEqual(try MobilePilotConfiguration.callbackCode(URL(string: callback)!, expectedState: state), code)
        let invalid = [callback + "&code=\(code)", callback + "&state=\(state)", callback + "&extra=yes", callback + "#token",
            callback.replacingOccurrences(of: "auth/callback", with: "other/callback"),
            callback.replacingOccurrences(of: "auth/callback", with: "auth/callback/"),
            callback.replacingOccurrences(of: "auth/callback", with: "user@auth/callback"),
            callback.replacingOccurrences(of: "auth/callback", with: "auth:123/callback"),
            callback.replacingOccurrences(of: "state=\(state)", with: "state=wrong"),
            callback.replacingOccurrences(of: "code=\(code)", with: "code=short")]
        for value in invalid { XCTAssertThrowsError(try MobilePilotConfiguration.callbackCode(URL(string: value)!, expectedState: state), value) }
    }
    func testPaginationDeduplicatesAndRejectsLoopsAndExhaustedReload() throws {
        var collection = MobileOperationCollection()
        try collection.append(page(["source:one"], cursor: "next1"), requestedCursor: nil)
        try collection.append(page(["source:one", "source:two"], cursor: "next2"), requestedCursor: "next1")
        XCTAssertEqual(collection.operations.map(\.id), ["source:one", "source:two"])
        XCTAssertThrowsError(try collection.append(page(["source:three"], cursor: "next1"), requestedCursor: "next2"))
        XCTAssertEqual(collection.operations.count, 2)
        try collection.append(page(["source:three"]), requestedCursor: "next2")
        XCTAssertNil(collection.nextCursor)
        XCTAssertThrowsError(try collection.append(page(["source:one"]), requestedCursor: nil))
        XCTAssertEqual(collection.operations.count, 3)
    }
    func testMalformedPageDoesNotChangeLoadedData() throws {
        var collection = MobileOperationCollection()
        XCTAssertThrowsError(try collection.append(page(["duplicate", "duplicate"]), requestedCursor: nil))
        XCTAssertThrowsError(try collection.append(page([""]), requestedCursor: nil))
        XCTAssertThrowsError(try collection.append(page((1...51).map(String.init)), requestedCursor: nil))
        XCTAssertTrue(collection.operations.isEmpty)
    }
    func testLiveFieldsPreserveUnknownStatusAndAbsentOptionalFields() throws {
        let decoded = try page(["source:job"]).operations[0]
        XCTAssertEqual(decoded.status, "Awaiting external review")
        XCTAssertNil(decoded.location)
        XCTAssertNil(decoded.projectName)
        XCTAssertNil(decoded.scheduledStart)
    }
    func testExpiredTokenIsNotCurrent() throws {
        let data = Data("{\"accessToken\":\"test\",\"tokenType\":\"Bearer\",\"expiresAt\":1}".utf8)
        XCTAssertFalse(try JSONDecoder().decode(MobilePilotToken.self, from: data).isCurrent)
    }
}
