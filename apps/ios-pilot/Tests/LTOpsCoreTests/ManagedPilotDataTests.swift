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
        guard ["pilot.example.test", "ios-pilot-staging.ledgetop.app"].contains(url.host ?? ""), request.httpMethod == "GET", request.httpBody == nil,
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

private final class DelayedIdentityStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Thread.sleep(forTimeInterval: 0.2)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        let body = "{\"schemaVersion\":1,\"readOnly\":true,\"user\":{\"id\":\"staff\",\"displayName\":\"Test\",\"email\":\"staff@example.test\"},\"expiresAt\":\(Int(Date().timeIntervalSince1970) + 60)}"
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
private final class ValidProbeStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true,"kind":"synthetic-oauth-probe"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private class ContextProbeStub: URLProtocol, @unchecked Sendable {
    class var context: String { "untrusted-private-header-value" }
    class var stage: String { "ok" }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "application/json", "X-LT-Ops-Probe-Stage": type(of: self).stage,
            "X-LT-Ops-Access-Context": type(of: self).context])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true,"kind":"synthetic-oauth-probe"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private final class ContextMatchStub: ContextProbeStub, @unchecked Sendable { override class var context: String { "match" } }
private final class ContextMissingStub: ContextProbeStub, @unchecked Sendable { override class var context: String { "missing" } }
private final class ContextAudienceStub: ContextProbeStub, @unchecked Sendable { override class var context: String { "audience-mismatch" } }
private final class ContextUnavailableStub: ContextProbeStub, @unchecked Sendable { override class var context: String { "identity-unavailable" } }
private final class ContextMismatchStub: ContextProbeStub, @unchecked Sendable { override class var context: String { "identity-mismatch" } }
private final class ContextWrongStageStub: ContextProbeStub, @unchecked Sendable {
    override class var context: String { "match" }
    override class var stage: String { "unrecognized" }
}

private class ProbeFailureStub: URLProtocol, @unchecked Sendable {
    class var marker: String? { nil }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var headers = ["Content-Type": "application/json"]
        if let marker = type(of: self).marker { headers["X-LT-Ops-Probe-Stage"] = marker }
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private final class OriginBearerStub: ProbeFailureStub, @unchecked Sendable { override class var marker: String? { "bearer-rejected" } }
private final class OriginAssertionStub: ProbeFailureStub, @unchecked Sendable { override class var marker: String? { "assertion-invalid" } }
private final class UnknownStageStub: ProbeFailureStub, @unchecked Sendable { override class var marker: String? { "untrusted-provider-value" } }

final class ManagedPilotDataTests: XCTestCase, @unchecked Sendable {
    private func revocationAPI(stub: AnyClass) throws -> ManagedPilotDataAPI {
        let issuer = "https://team.example.test"
        let pins = try ManagedOAuthPins(resource: "https://ios-pilot-staging.ledgetop.app", issuer: issuer,
            authorizationEndpoint: issuer + "/auth", tokenEndpoint: issuer + "/token",
            registrationEndpoint: issuer + "/register", revocationEndpoint: issuer + "/revoke")
        return ManagedPilotDataAPI(pins: pins, protocolClasses: [stub])
    }
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
    func testRevocationProbeRequiresExactHostAndClassifiesOnlyKnownOutcomes() async throws {
        let good = await (try revocationAPI(stub: ValidProbeStub.self)).checkSyntheticRevocation(credential: credential())
        let unauthorized = await (try revocationAPI(stub: ProbeFailureStub.self)).checkSyntheticRevocation(credential: credential())
        let marker = await (try revocationAPI(stub: OriginAssertionStub.self)).checkSyntheticRevocation(credential: credential())
        let invalid = await (try revocationAPI(stub: InvalidProbeStub.self)).checkSyntheticRevocation(credential: credential())
        let expired = await (try revocationAPI(stub: ValidProbeStub.self)).checkSyntheticRevocation(credential: credential(expiry: -1))
        let wrongHost = await (try api(stub: ValidProbeStub.self)).checkSyntheticRevocation(credential: credential())
        XCTAssertEqual(good, .accepted); XCTAssertEqual(unauthorized, .rejected)
        XCTAssertEqual(marker, .inconclusive); XCTAssertEqual(invalid, .inconclusive)
        XCTAssertEqual(expired, .inconclusive); XCTAssertEqual(wrongHost, .inconclusive)
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
    func testSessionBoundsAccessAndRejectsExpiryDuringIdentityRequest() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        func session(expiry: Int, readOnly: Bool = true) throws -> MobilePilotSession {
            let json = "{\"schemaVersion\":1,\"readOnly\":\(readOnly),\"user\":{\"id\":\"staff\",\"displayName\":\"Test\",\"email\":\"staff@example.test\"},\"expiresAt\":\(expiry)}"
            return try JSONDecoder().decode(MobilePilotSession.self, from: Data(json.utf8))
        }
        let token = ManagedOAuthCredential(accessToken: "oauth:synthetic", refreshToken: "oauth:must-not-leak", expiresAt: now.addingTimeInterval(300))
        let short = try ManagedPilotDataAPI.credential(token, boundedBy: session(expiry: 1_060), now: now)
        XCTAssertEqual(short.expiresAt, now.addingTimeInterval(60))
        XCTAssertNil(short.refreshToken)
        let long = try ManagedPilotDataAPI.credential(token, boundedBy: session(expiry: 1_600), now: now)
        XCTAssertEqual(long.expiresAt, token.expiresAt)
        // Both authorities must still be current after the identity response.
        XCTAssertThrowsError(try ManagedPilotDataAPI.credential(token, boundedBy: session(expiry: 1_060), now: now.addingTimeInterval(60)))
        XCTAssertThrowsError(try ManagedPilotDataAPI.credential(token, boundedBy: session(expiry: 1_600), now: now.addingTimeInterval(300)))
        XCTAssertThrowsError(try ManagedPilotDataAPI.credential(token, boundedBy: session(expiry: 1_060, readOnly: false), now: now))
    }
    func testIdentityRequestFailsIfAccessExpiresWhileResponseIsInFlight() async throws {
        let client = try api(stub: DelayedIdentityStub.self)
        do {
            _ = try await client.identity(credential: credential(expiry: 0.1))
            XCTFail("accepted an expired credential after the response")
        } catch { XCTAssertEqual(error as? MobilePilotError, .expired) }
    }
    func testSyntheticProbeUsesFixedTestEndpoint() async throws {
        try await revocationAPI(stub: ManagedDataStub.self).verifySyntheticProbe(credential: credential())
        do { try await revocationAPI(stub: InvalidProbeStub.self).verifySyntheticProbe(credential: credential()); XCTFail("accepted wrong marker") }
        catch { XCTAssertEqual(error as? SyntheticProbeFailure, .unexpectedResponse) }
        do { try await api().verifySyntheticProbe(credential: credential()); XCTFail("accepted unreviewed origin") }
        catch { XCTAssertEqual(error as? SyntheticProbeFailure, .unexpectedResponse) }
    }
    func testSyntheticContextIsAllowlistedAndRequiresSuccessStage() async throws {
        let cases: [(AnyClass, SyntheticAccessContext)] = [
            (ContextMatchStub.self, .match), (ContextMissingStub.self, .missing),
            (ContextAudienceStub.self, .audienceMismatch), (ContextUnavailableStub.self, .identityUnavailable),
            (ContextMismatchStub.self, .identityMismatch), (ContextProbeStub.self, .unknown),
            (ContextWrongStageStub.self, .unknown), (ValidProbeStub.self, .unknown)]
        for (stub, expected) in cases {
            let observed = try await revocationAPI(stub: stub).verifySyntheticProbe(credential: credential())
            XCTAssertEqual(observed, expected)
            XCTAssertFalse(observed.message.contains("untrusted-private-header-value"))
        }
    }
    func testProbeFailureCategoriesUseOnlyFixedStages() async throws {
        let cases: [(AnyClass, SyntheticProbeFailure)] = [(ProbeFailureStub.self, .edgeUnauthorized),
            (OriginBearerStub.self, .originBearer), (OriginAssertionStub.self, .originAssertionInvalid),
            (UnknownStageStub.self, .unexpectedResponse)]
        for (stub, expected) in cases {
            do { try await revocationAPI(stub: stub).verifySyntheticProbe(credential: credential()); XCTFail("accepted rejected probe") }
            catch { XCTAssertEqual(error as? SyntheticProbeFailure, expected) }
        }
        do { try await revocationAPI(stub: ManagedDataStub.self).verifySyntheticProbe(credential: credential("invalid-secret-value")); XCTFail("accepted invalid token") }
        catch { XCTAssertEqual(error as? SyntheticProbeFailure, .credential) }
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
