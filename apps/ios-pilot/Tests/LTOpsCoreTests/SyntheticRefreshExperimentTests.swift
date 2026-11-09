import Foundation
import XCTest
@testable import LTOpsCore

private actor SyntheticRefreshStub: SyntheticRefreshTransport {
    enum Mode: Sendable { case revokeFamily, replayAllowed, currentAllowed, unchanged, missing, network }
    let mode: Mode
    var calls: [String] = []
    var revoked: [String] = []
    init(_ mode: Mode) { self.mode = mode }
    func strictRefresh(token: String, clientID: String) async throws -> ManagedOAuthCredential {
        calls.append(token)
        if mode == .network { throw URLError(.networkConnectionLost) }
        func result(_ access: String, _ refresh: String?) -> ManagedOAuthCredential {
            ManagedOAuthCredential(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(300))
        }
        if token == "oauth:r0" {
            if mode == .unchanged { return result("oauth:a1", "oauth:r0") }
            if mode == .missing { return result("oauth:a1", nil) }
            return result("oauth:a1", "oauth:r1")
        }
        if token == "oauth:r1" && calls.count == 2 { return result("oauth:a2", "oauth:r2") }
        if token == "oauth:r1" && mode == .replayAllowed { return result("oauth:a3", "oauth:r3") }
        if token == "oauth:r1" { throw ManagedOAuthRevocationFailure.httpStatus(400) }
        if token == "oauth:r2" && mode == .currentAllowed { return result("oauth:a4", "oauth:r4") }
        throw ManagedOAuthRevocationFailure.httpStatus(400)
    }
    func revoke(token: String, clientID: String, hint: ManagedOAuthTokenKind) async throws { revoked.append(token) }
    func snapshot() -> ([String], [String]) { (calls, revoked) }
}

final class SyntheticRefreshExperimentTests: XCTestCase, @unchecked Sendable {
    private func pins() throws -> ManagedOAuthPins {
        let issuer = "https://ledgetoptechnologies.cloudflareaccess.com"
        return try ManagedOAuthPins(resource: SyntheticRefreshExperiment.resource, issuer: issuer,
            authorizationEndpoint: issuer + "/cdn-cgi/access/oauth/authorization", tokenEndpoint: issuer + "/cdn-cgi/access/oauth/token",
            registrationEndpoint: issuer + "/cdn-cgi/access/oauth/registration", revocationEndpoint: issuer + "/cdn-cgi/access/oauth/revoke")
    }
    private var credential: ManagedOAuthCredential { ManagedOAuthCredential(accessToken: "oauth:a0", refreshToken: "oauth:r0", expiresAt: Date().addingTimeInterval(300)) }
    func testRejectsReplayAndChecksActiveTokenThenCleansAllKnownCredentials() async throws {
        let stub = SyntheticRefreshStub(.revokeFamily)
        let report = await SyntheticRefreshExperiment.run(pins: try pins(), credential: credential, clientID: "client", transport: stub)
        XCTAssertEqual(report.observation, .rotatedReplayRejectedCurrentRejected)
        XCTAssertFalse(report.cleanupUnconfirmed)
        let (calls, revoked) = await stub.snapshot()
        XCTAssertEqual(calls, ["oauth:r0", "oauth:r1", "oauth:r1", "oauth:r2"])
        XCTAssertEqual(Set(revoked), Set(["oauth:r0", "oauth:r1", "oauth:r2", "oauth:a0", "oauth:a1", "oauth:a2"]))
    }
    func testClassifiesReplayAndMissingRotationWithoutLeakingCredentials() async throws {
        for (mode, expected) in [(SyntheticRefreshStub.Mode.replayAllowed, SyntheticRefreshObservation.replayAccepted),
            (.currentAllowed, .rotatedReplayRejectedCurrentAccepted), (.unchanged, .notRotated), (.missing, .inconclusive), (.network, .inconclusive)] {
            let stub = SyntheticRefreshStub(mode)
            let report = await SyntheticRefreshExperiment.run(pins: try pins(), credential: credential, clientID: "client", transport: stub)
            XCTAssertEqual(report.observation, expected)
            if mode == .network { XCTAssertTrue(report.cleanupUnconfirmed) }
            let (_, revoked) = await stub.snapshot()
            XCTAssertTrue(revoked.contains("oauth:r0"))
            XCTAssertTrue(revoked.contains("oauth:a0"))
        }
    }
}
