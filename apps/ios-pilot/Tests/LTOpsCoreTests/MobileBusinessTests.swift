import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import LTOpsCore

private final class BusinessStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, url.host == "ios-pilot-staging.ledgetop.app", request.httpMethod == "GET",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer oauth:synthetic", request.httpBody == nil else {
            client?.urlProtocol(self, didFailWithError: MobilePilotError.invalidResponse); return
        }
        let body: String
        switch url.path {
        case "/mobile-pilot/v1/business-roots":
            body = #"{"schemaVersion":1,"roots":[{"sourceId":"project-alpha:staging","rootNamespace":"business","kind":"organization","clientHubRootId":"client-1","name":"Example"}],"nextCursor":null}"#
        case "/mobile-pilot/v1/business-roots/organization/client-1/projects":
            body = #"{"schemaVersion":1,"projects":[{"id":"same","origin":"pa","name":"First","status":null,"startDate":null,"endDate":null},{"id":"same","origin":"canonical","name":"Second","status":"active","startDate":null,"endDate":null}],"nextCursor":null}"#
        default: client?.urlProtocol(self, didFailWithError: MobilePilotError.invalidResponse); return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class MobileBusinessTests: XCTestCase, @unchecked Sendable {
    private let decoder = JSONDecoder()
    private let root = #"{"sourceId":"project-alpha:staging","rootNamespace":"business","kind":"organization","clientHubRootId":"client-1","name":"Example"}"#
    private func roots(_ body: String) throws -> MobileBusinessRootsPage { try decoder.decode(MobileBusinessRootsPage.self, from: Data(body.utf8)) }
    private func projects(_ body: String) throws -> MobileBusinessProjectsPage { try decoder.decode(MobileBusinessProjectsPage.self, from: Data(body.utf8)) }

    func testEmptyFilteredPageRetainsCursorAndRejectsLoops() throws {
        var collection = MobileBusinessRoots()
        try collection.append(roots(#"{"schemaVersion":1,"roots":[],"nextCursor":"next"}"#), requestedCursor: nil)
        XCTAssertTrue(collection.roots.isEmpty); XCTAssertEqual(collection.nextCursor, "next")
        try collection.append(roots("{\"schemaVersion\":1,\"roots\":[\(root)],\"nextCursor\":null}"), requestedCursor: "next")
        XCTAssertEqual(collection.roots.count, 1)
        var invalid = MobileBusinessRoots()
        try invalid.append(roots(#"{"schemaVersion":1,"roots":[],"nextCursor":"again"}"#), requestedCursor: nil)
        XCTAssertThrowsError(try invalid.append(roots(#"{"schemaVersion":1,"roots":[],"nextCursor":"again"}"#), requestedCursor: "again"))
    }

    func testRejectsWrongSourceAndRetainsCollidingProjectIdsByOrigin() throws {
        var rootsCollection = MobileBusinessRoots()
        let wrong = root.replacingOccurrences(of: "project-alpha:staging", with: "project-alpha:primary")
        XCTAssertThrowsError(try rootsCollection.append(roots("{\"schemaVersion\":1,\"roots\":[\(wrong)],\"nextCursor\":null}"), requestedCursor: nil))
        var collection = MobileBusinessProjects()
        let page = #"{"schemaVersion":1,"projects":[{"id":"same","origin":"pa","name":"One","status":null,"startDate":null,"endDate":null},{"id":"same","origin":"canonical","name":"Two","status":null,"startDate":null,"endDate":null}],"nextCursor":null}"#
        try collection.append(projects(page), requestedCursor: nil)
        XCTAssertEqual(collection.projects.count, 2)
        XCTAssertNotEqual(collection.projects[0].id, collection.projects[1].id)
    }

    func testTransportUsesOnlyFixedStagingOrigin() async throws {
        let issuer = "https://team.example.test"
        func pins(_ resource: String) throws -> ManagedOAuthPins {
            try ManagedOAuthPins(resource: resource, issuer: issuer, authorizationEndpoint: issuer + "/auth",
                tokenEndpoint: issuer + "/token", registrationEndpoint: issuer + "/register", revocationEndpoint: issuer + "/revoke")
        }
        let credential = ManagedOAuthCredential(accessToken: "oauth:synthetic", refreshToken: nil, expiresAt: Date().addingTimeInterval(60))
        let api = ManagedPilotDataAPI(pins: try pins("https://ios-pilot-staging.ledgetop.app"), protocolClasses: [BusinessStub.self])
        let page = try await api.businessRoots(credential: credential)
        let items = try await api.businessProjects(credential: credential, root: page.roots[0])
        XCTAssertEqual(items.projects.count, 2)
        let other = ManagedPilotDataAPI(pins: try pins("https://pilot.example.test"), protocolClasses: [BusinessStub.self])
        do { _ = try await other.businessRoots(credential: credential); XCTFail("Expected staging origin restriction") }
        catch { XCTAssertEqual(error as? MobilePilotError, .unavailable) }
    }
}
