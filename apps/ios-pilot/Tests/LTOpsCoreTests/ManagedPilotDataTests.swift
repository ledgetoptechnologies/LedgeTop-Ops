import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import LTOpsCore

private final class ManagedDataStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        guard url.host == "pilot.example.test", request.httpMethod == "GET", request.httpBody == nil,
              request.value(forHTTPHeaderField: "Authorization") == "Bearer oauth:synthetic",
              request.value(forHTTPHeaderField: "Accept") == "application/json",
              request.value(forHTTPHeaderField: "Cache-Control") == "no-store",
              request.value(forHTTPHeaderField: "Cookie") == nil else {
            client?.urlProtocol(self, didFailWithError: MobilePilotError.invalidResponse); return
        }
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
        var status = 200, type = "application/json"
        var body = ""
        let operation = #"{"id":"op-1","title":"Test operation","status":"scheduled","scheduledStart":null,"scheduledEnd":null,"location":null,"projectName":null,"divisionName":null}"#
        switch url.path {
        case "/oauth-probe/v1": body = #"{"ok":true,"kind":"synthetic-oauth-probe"}"#
        case "/mobile-pilot/v1/session":
            body = "{\"schemaVersion\":1,\"readOnly\":true,\"user\":{\"id\":\"staff\",\"displayName\":\"Test\",\"email\":\"staff@example.test\"},\"expiresAt\":\(Int(Date().timeIntervalSince1970) + 600)}"
        case "/mobile-pilot/v1/operations":
            switch cursor {
            case "unauthorized": status = 401
            case "denied": status = 403
            case "missing": status = 404
            case "unavailable": status = 503
            case "redirect": status = 302
            case "html": type = "text/html"
            case "oversized": body = String(repeating: "a", count: 1_048_577)
            case "no-response": client?.urlProtocolDidFinishLoading(self); return
            default: body = "{\"schemaVersion\":1,\"operations\":[\(operation)],\"nextCursor\":null}"
            }
        case "/mobile-pilot/v1/operations/op-1": body = "{\"schemaVersion\":1,\"operation\":\(operation)}"
        default: status = 404
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class InvalidProbeStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true,"kind":"wrong"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ManagedPilotDataTests: XCTestCase, @unchecked Sendable {
    private func api(stub: AnyClass = ManagedDataStub.self) throws -> ManagedPilotDataAPI {
        let issuer = "https://team.example.test"
        let pins = try ManagedOAuthPins(resource: "https://pilot.example.test", issuer: issuer,
            authorizationEndpoint: issuer + "/auth", tokenEndpoint: issuer + "/token",
            registrationEndpoint: issuer + "/register", revocationEndpoint: issuer + "/revoke")
        return ManagedPilotDataAPI(pins: pins, protocolClasses: [stub])
    }
    private func credential(_ token: String = "oauth:synthetic", expiry: TimeInterval = 300) -> ManagedOAuthCredential {
        ManagedOAuthCredential(accessToken: token, refreshToken: nil, expiresAt: Date().addingTimeInterval(expiry))
    }
    func testReadOnlySessionListAndDetail() async throws {
        let api = try api(), token = credential()
        let session = try await api.identity(credential: token)
        XCTAssertTrue(session.readOnly)
        let page = try await api.operations(credential: token, cursor: "encoded+cursor")
        XCTAssertEqual(page.operations.map(\.id), ["op-1"])
        let operation = try await api.operation(credential: token, id: "op-1")
        XCTAssertEqual(operation.title, "Test operation")
    }
    func testSyntheticProbeUsesFixedTestEndpoint() async throws {
        try await api().verifySyntheticProbe(credential: credential())
        do { try await api(stub: InvalidProbeStub.self).verifySyntheticProbe(credential: credential()); XCTFail("accepted wrong marker") }
        catch { XCTAssertEqual(error as? MobilePilotError, .invalidResponse) }
    }
    func testRejectsExpiredAndMalformedCredentialsAndDotSegments() async throws {
        let api = try api()
        for token in [credential("oauth:a\r\nX-Test:bad"), credential("not-oauth"), credential(expiry: -1)] {
            do { _ = try await api.identity(credential: token); XCTFail("accepted bad credential") }
            catch { XCTAssertNotNil(error as? MobilePilotError) }
        }
        for id in ["", ".", ".."] {
            do { _ = try await api.operation(credential: credential(), id: id); XCTFail("accepted bad ID") }
            catch { XCTAssertEqual(error as? MobilePilotError, .invalidResponse) }
        }
    }
    func testErrorsAndUntrustedResponsesFailClosed() async throws {
        let api = try api(), token = credential()
        let cases: [(String, MobilePilotError)] = [("unauthorized", .signedOut), ("denied", .denied),
            ("missing", .notFound), ("unavailable", .unavailable), ("redirect", .invalidResponse),
            ("html", .invalidResponse), ("oversized", .invalidResponse), ("no-response", .invalidResponse)]
        for (cursor, expected) in cases {
            do { _ = try await api.operations(credential: token, cursor: cursor); XCTFail("accepted \(cursor)") }
            catch { XCTAssertEqual(error as? MobilePilotError, expected) }
        }
    }
}
