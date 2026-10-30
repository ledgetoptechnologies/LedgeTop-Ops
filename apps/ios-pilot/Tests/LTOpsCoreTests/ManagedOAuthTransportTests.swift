import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import LTOpsCore

private final class OAuthProtocolStub: URLProtocol, @unchecked Sendable {
    static let cancellationStarted = DispatchSemaphore(value: 0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let host = url.host ?? ""
        let base = "https://\(host)"
        var status = 200
        var type = "application/json"
        var body = ""
        if url.path == "/.well-known/oauth-authorization-server" && request.httpMethod == "GET" {
            body = """
            {"issuer":"\(base)","authorization_endpoint":"\(base)/auth","token_endpoint":"\(base)/token","registration_endpoint":"\(base)/register","revocation_endpoint":"\(base)/revoke","response_types_supported":["code"],"grant_types_supported":["authorization_code"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"]}
            """
            if host == "changed.example.test" { body = body.replacingOccurrences(of: "/token", with: "/unexpected") }
        } else if url.path == "/register" && request.httpMethod == "POST" {
            status = 201
            guard request.value(forHTTPHeaderField: "Content-Type") == "application/json",
                  let bytes = request.httpBody,
                  let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  data["token_endpoint_auth_method"] as? String == "none" else { client?.urlProtocol(self, didFailWithError: MobilePilotError.invalidResponse); return }
            body = """
            {"client_id":"client-id","redirect_uris":["com.ledgetoptechnologies.ops.pilot://auth/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}
            """
        } else if url.path == "/token" && request.httpMethod == "POST" {
            guard request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded",
                  let bytes = request.httpBody, let form = String(data: bytes, encoding: .utf8),
                  form.contains("code_verifier=") else { client?.urlProtocol(self, didFailWithError: MobilePilotError.invalidResponse); return }
            if form.contains("code=redirect") { status = 302 }
            if form.contains("code=html") { type = "text/html" }
            if form.contains("code=no-response") { client?.urlProtocolDidFinishLoading(self); return }
            if form.contains("code=cancel") {
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                Self.cancellationStarted.signal()
                return
            }
            if form.contains("code=oversized") { body = String(repeating: "a", count: 65_537) }
            else {
                let resource = form.contains("code=wrong-resource") ? "https://other.example.test/" : "https://pilot.example.test/"
                let expiry = form.contains("code=long-expiry") ? 901 : 900
                let token = form.contains("code=bad-token") ? "not-oauth" : "oauth:synthetic-access"
                body = "{\"access_token\":\"\(token)\",\"token_type\":\"bearer\",\"expires_in\":\(expiry),\"resource\":\"\(resource)\",\"refresh_token\":\"oauth:synthetic-refresh\"}"
            }
        } else { status = 404 }
        if request.value(forHTTPHeaderField: "Accept") != "application/json" || request.value(forHTTPHeaderField: "Cache-Control") != "no-store" { status = 500 }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ManagedOAuthTransportTests: XCTestCase, @unchecked Sendable {
    private func transport(host: String = "team.example.test") throws -> ManagedOAuthTransport {
        let base = "https://\(host)"
        let pins = try ManagedOAuthPins(resource: "https://pilot.example.test", issuer: base,
            authorizationEndpoint: base + "/auth", tokenEndpoint: base + "/token",
            registrationEndpoint: base + "/register", revocationEndpoint: base + "/revoke")
        return ManagedOAuthTransport(pins: pins, protocolClasses: [OAuthProtocolStub.self])
    }
    func testDiscoveryRegistrationAndExchange() async throws {
        let client = try transport()
        try await client.verifyMetadata()
        let id = try await client.register()
        XCTAssertEqual(id, "client-id")
        let result = try await client.exchange(code: "synthetic", verifier: String(repeating: "v", count: 43), clientID: id)
        XCTAssertEqual(result.accessToken, "oauth:synthetic-access")
        XCTAssertEqual(result.refreshToken, "oauth:synthetic-refresh")
        XCTAssertLessThanOrEqual(result.expiresAt.timeIntervalSinceNow, 900)
    }
    func testChangedDiscoveryFailsClosed() async throws {
        do { try await transport(host: "changed.example.test").verifyMetadata(); XCTFail("Accepted changed endpoint") }
        catch { XCTAssertEqual(error as? MobilePilotError, .invalidResponse) }
    }
    func testTokenFailuresRejectUnexpectedResponses() async throws {
        let client = try transport()
        for code in ["redirect", "html", "oversized", "wrong-resource", "long-expiry", "bad-token", "no-response"] {
            do { _ = try await client.exchange(code: code, verifier: String(repeating: "v", count: 43), clientID: "client-id"); XCTFail("Accepted \(code)") }
            catch { XCTAssertEqual(error as? MobilePilotError, .invalidResponse) }
        }
    }
    func testCancellationAfterResponseBeforeCompletionFailsClosed() async throws {
        let client = try transport()
        let pending = Task { try await client.exchange(code: "cancel", verifier: String(repeating: "v", count: 43), clientID: "client-id") }
        let began = await Task.detached { OAuthProtocolStub.cancellationStarted.wait(timeout: .now() + 5) == .success }.value
        XCTAssertTrue(began)
        pending.cancel()
        do { _ = try await pending.value; XCTFail("Accepted cancelled exchange") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
}
