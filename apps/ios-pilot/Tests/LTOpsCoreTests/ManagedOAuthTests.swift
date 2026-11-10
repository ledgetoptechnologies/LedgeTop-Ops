import Foundation
import XCTest
@testable import LTOpsCore

final class ManagedOAuthTests: XCTestCase {
    private func pins() throws -> ManagedOAuthPins {
        try ManagedOAuthPins(resource: "https://pilot.example.test", issuer: "https://team.cloudflareaccess.com",
            authorizationEndpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
            tokenEndpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
            registrationEndpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
            revocationEndpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/revoke")
    }
    private let state = String(repeating: "s", count: 43)
    private let challenge = String(repeating: "A", count: 43)
    func testMetadataRequiresPinnedEndpointsAndPublicPKCE() throws {
        let json = #"{"issuer":"https://team.cloudflareaccess.com","authorization_endpoint":"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization","token_endpoint":"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token","registration_endpoint":"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration","revocation_endpoint":"https://team.cloudflareaccess.com/cdn-cgi/access/oauth/revoke","response_types_supported":["code"],"grant_types_supported":["authorization_code"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"]}"#
        let metadata = try JSONDecoder().decode(ManagedOAuthMetadata.self, from: Data(json.utf8))
        XCTAssertNoThrow(try metadata.validate(pins: pins()))
        let bad = json.replacingOccurrences(of: "/oauth/token", with: "/oauth/other")
        let changed = try JSONDecoder().decode(ManagedOAuthMetadata.self, from: Data(bad.utf8))
        XCTAssertThrowsError(try changed.validate(pins: pins()))
        let noPKCE = json.replacingOccurrences(of: "S256", with: "plain")
        XCTAssertThrowsError(try JSONDecoder().decode(ManagedOAuthMetadata.self, from: Data(noPKCE.utf8)).validate(pins: pins()))
    }
    func testPinsRejectForeignEndpoint() {
        XCTAssertThrowsError(try ManagedOAuthPins(resource: "https://pilot.example.test", issuer: "https://team.cloudflareaccess.com",
            authorizationEndpoint: "https://evil.example.test/auth", tokenEndpoint: "https://team.cloudflareaccess.com/token",
            registrationEndpoint: "https://team.cloudflareaccess.com/register", revocationEndpoint: "https://team.cloudflareaccess.com/revoke"))
    }
    func testRegistrationIsPublicAndValidatesResponse() throws {
        let body = try ManagedOAuthWire.registrationBody(pins: pins())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["token_endpoint_auth_method"] as? String, "none")
        XCTAssertEqual(object["resource"] as? String, "https://pilot.example.test")
        let valid = #"{"client_id":"client-id","redirect_uris":["com.ledgetoptechnologies.ops.pilot://auth/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}"#
        XCTAssertEqual(try ManagedOAuthWire.registeredClient(Data(valid.utf8)), "client-id")
        XCTAssertThrowsError(try ManagedOAuthWire.registeredClient(Data(valid.replacingOccurrences(of: "client-id", with: "client-id\",\"client_secret\":\"secret").utf8)))
    }
    func testAuthorizationBindsResourceStateAndS256() throws {
        let url = try ManagedOAuthWire.authorizationURL(pins: pins(), clientID: "client-id", state: state, challenge: challenge)
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items.first(where: { $0.name == "resource" })?.value, "https://pilot.example.test")
        XCTAssertEqual(items.first(where: { $0.name == "state" })?.value, state)
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge_method" })?.value, "S256")
        XCTAssertThrowsError(try ManagedOAuthWire.authorizationURL(pins: pins(), clientID: "client-id", state: state,
            challenge: "_" + String(repeating: "A", count: 42)))
    }
    func testCallbackAndExchangeRejectInjection() throws {
        let valid = try XCTUnwrap(URL(string: ManagedOAuthWire.callback + "?code=synthetic%2Bcode&state=" + state))
        XCTAssertEqual(try ManagedOAuthWire.callbackCode(valid, state: state), "synthetic+code")
        let duplicate = try XCTUnwrap(URL(string: ManagedOAuthWire.callback + "?code=one&code=two&state=" + state))
        XCTAssertThrowsError(try ManagedOAuthWire.callbackCode(duplicate, state: state))
        XCTAssertThrowsError(try ManagedOAuthWire.callbackCode(valid, state: String(repeating: "x", count: 43)))
        let body = try ManagedOAuthWire.exchangeBody(code: "synthetic+code&x", verifier: String(repeating: "v", count: 43), clientID: "client-id")
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("code=synthetic%2Bcode%26x"))
    }
}
