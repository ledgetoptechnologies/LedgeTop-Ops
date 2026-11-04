import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LTOpsCore

private final class PilotProtocolStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let auth = request.value(forHTTPHeaderField: "Authorization") ?? ""
        var status = 200
        var contentType = "application/json"
        var body = "{\"schemaVersion\":1,\"operations\":[],\"nextCursor\":null}"
        if request.url?.host != "ios-pilot-staging.ledgetop.app" || request.httpMethod != "GET"
            || request.value(forHTTPHeaderField: "Accept") != "application/json" || request.value(forHTTPHeaderField: "Cache-Control") != "no-store" {
            status = 500
        } else if auth == "Bearer expired" { status = 401 }
        else if auth == "Bearer denied" { status = 403 }
        else if auth == "Bearer html" { contentType = "text/html"; body = "<html>Sign in</html>" }
        else if auth == "Bearer redirect" { status = 302 }
        else if auth == "Bearer wrongschema" { body = "{\"schemaVersion\":2,\"operations\":[],\"nextCursor\":null}" }
        else if auth == "Bearer cursor" && URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value != "opaque+with/slash=" { status = 500 }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

// XCTest owns execution; this class has no mutable test state.
final class MobilePilotTransportTests: XCTestCase, @unchecked Sendable {
    private func api() throws -> MobilePilotAPI {
        let config = try MobilePilotConfiguration(enabled: true, origin: "https://ios-pilot-staging.ledgetop.app")
        let options = URLSessionConfiguration.ephemeral
        options.protocolClasses = [PilotProtocolStub.self]
        return MobilePilotAPI(configuration: config, testingSession: URLSession(configuration: options))
    }
    private func token(_ value: String, expiry: Int? = nil) throws -> MobilePilotToken {
        let body: [String: Any] = ["accessToken": value, "tokenType": "Bearer", "expiresAt": expiry ?? Int(Date().timeIntervalSince1970) + 600]
        return try JSONDecoder().decode(MobilePilotToken.self, from: JSONSerialization.data(withJSONObject: body))
    }
    func testReadUsesFixedOriginHeadersAndEncodesOpaqueCursor() async throws {
        let client = try api()
        let page = try await client.operations(token: token("cursor"), cursor: "opaque+with/slash=")
        XCTAssertTrue(page.operations.isEmpty)
    }
    func testAuthenticationAndUnexpectedResponsesFailClosed() async throws {
        let client = try api()
        for (value, expected) in [("expired", MobilePilotError.signedOut), ("denied", .denied), ("html", .invalidResponse), ("redirect", .invalidResponse), ("wrongschema", .invalidResponse)] {
            do { _ = try await client.operations(token: token(value)); XCTFail("Accepted \(value)") }
            catch let error as MobilePilotError { XCTAssertEqual(error, expected) }
        }
    }
    func testExpiredLocalSessionCannotRead() async throws {
        let client = try api()
        do { _ = try await client.operations(token: token("ok", expiry: 1)); XCTFail("Accepted expired session") }
        catch let error as MobilePilotError { XCTAssertEqual(error, .expired) }
    }
}
