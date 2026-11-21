import Foundation
import XCTest
@testable import LTOpsCore

final class PilotOperationsAccessTests: XCTestCase, @unchecked Sendable {
    private func session(id: String = "staff", email: String = "staff@example.test", expiry: Int = 600) throws -> MobilePilotSession {
        let json = "{\"schemaVersion\":1,\"readOnly\":true,\"user\":{\"id\":\"\(id)\",\"displayName\":\"Test\",\"email\":\"\(email)\"},\"expiresAt\":\(Int(Date().timeIntervalSince1970) + expiry)}"
        return try JSONDecoder().decode(MobilePilotSession.self, from: Data(json.utf8))
    }
    private func token(_ lifetime: TimeInterval = 600) -> ManagedOAuthCredential {
        ManagedOAuthCredential(accessToken: "oauth:synthetic", refreshToken: nil, expiresAt: Date().addingTimeInterval(lifetime))
    }
    func testDeniedOperationsKeepsOnlyReverifiedAndBoundedSession() async throws {
        let expected = try session(), updated = try session(expiry: 30)
        let result = try await PilotOperationsAccess.load(credential: token(), user: expected.user,
            operations: { throw MobilePilotError.denied }, identity: { updated })
        guard case let .restricted(credential) = result else { return XCTFail("Expected restricted operations") }
        XCTAssertLessThanOrEqual(credential.expiresAt.timeIntervalSince1970, Double(updated.expiresAt))
    }
    func testDenialDoesNotMaskRevokedChangedExpiredOrUnavailableSession() async throws {
        let expected = try session()
        let checks: [(MobilePilotSession?, MobilePilotError, MobilePilotError)] = [
            (nil, .signedOut, .signedOut), (nil, .unavailable, .unavailable),
            (try session(id: "other"), .invalidResponse, .signedOut),
            (try session(email: "other@example.test"), .invalidResponse, .signedOut),
            (try session(expiry: -1), .invalidResponse, .expired)]
        for (current, identityFailure, expectedError) in checks {
            do {
                _ = try await PilotOperationsAccess.load(credential: token(), user: expected.user,
                    operations: { throw MobilePilotError.denied }, identity: { guard let current else { throw identityFailure }; return current })
                XCTFail("Accepted unverified session")
            } catch { XCTAssertEqual(error as? MobilePilotError, expectedError) }
        }
        do {
            _ = try await PilotOperationsAccess.load(credential: token(-1), user: expected.user,
                operations: { throw MobilePilotError.denied }, identity: { expected })
            XCTFail("Accepted expired credential")
        } catch { XCTAssertEqual(error as? MobilePilotError, .expired) }
    }
    func testNonDenialOperationsErrorsAreNotConvertedToRestricted() async throws {
        let expected = try session()
        for failure: MobilePilotError in [.signedOut, .expired, .unavailable, .invalidResponse, .notFound] {
            do {
                _ = try await PilotOperationsAccess.load(credential: token(), user: expected.user,
                    operations: { throw failure }, identity: { XCTFail("Unexpected identity call"); return expected })
                XCTFail("Masked operations error")
            } catch { XCTAssertEqual(error as? MobilePilotError, failure) }
        }
    }
}
