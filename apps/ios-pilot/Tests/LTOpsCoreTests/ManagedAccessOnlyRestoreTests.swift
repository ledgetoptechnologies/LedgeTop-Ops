import XCTest
import Foundation
@testable import LTOpsCore

private final class AccessOnlyMemoryStore: ManagedAccessOnlyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var item: ManagedAccessOnlyRecord?
    func load() throws -> ManagedAccessOnlyRecord? { lock.lock(); defer { lock.unlock() }; return item }
    func save(_ value: ManagedAccessOnlyRecord) throws { lock.lock(); defer { lock.unlock() }; item = value }
    func clear() throws { lock.lock(); defer { lock.unlock() }; item = nil }
    var hasItem: Bool { lock.lock(); defer { lock.unlock() }; return item != nil }
}

private actor AccessIdentityGate {
    private var continuation: CheckedContinuation<MobilePilotSession, Error>?
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    func verify() async throws -> MobilePilotSession {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }
    func resume(with session: MobilePilotSession) { continuation?.resume(returning: session); continuation = nil }
}

final class ManagedAccessOnlyRestoreTests: XCTestCase, @unchecked Sendable {
    private let issuer = "https://ledgetoptechnologies.cloudflareaccess.com"
    private func pins(resource: String = "https://ios-pilot-read-staging.ledgetop.app") throws -> ManagedOAuthPins {
        try ManagedOAuthPins(resource: resource, issuer: issuer,
            authorizationEndpoint: issuer + "/cdn-cgi/access/oauth/authorization",
            tokenEndpoint: issuer + "/cdn-cgi/access/oauth/token",
            registrationEndpoint: issuer + "/cdn-cgi/access/oauth/registration",
            revocationEndpoint: issuer + "/cdn-cgi/access/oauth/revoke")
    }
    private func session(expiry: Date = Date().addingTimeInterval(300)) -> MobilePilotSession {
        MobilePilotSession(schemaVersion: 1, readOnly: true,
            user: MobilePilotUser(id: "staff-1", displayName: "Pilot Staff", email: "staff@example.test"),
            expiresAt: Int(expiry.timeIntervalSince1970))
    }
    private func credential(expiry: Date = Date().addingTimeInterval(300), refresh: String? = nil) -> ManagedOAuthCredential {
        ManagedOAuthCredential(accessToken: "oauth:access-token", refreshToken: refresh, expiresAt: expiry)
    }

    func testRecordContainsOnlyBoundedAccessCredentialNotProfileOrBusinessData() throws {
        let value = try ManagedAccessOnlyRecord(pins: pins(), credential: credential(), clientID: "client-1", session: session())
        let json = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        XCTAssertFalse(json.localizedCaseInsensitiveContains("refresh"))
        XCTAssertFalse(json.contains("displayName"))
        XCTAssertFalse(json.contains("operations"))
        XCTAssertNil(try value.credential(pins: pins()).refreshToken)
    }

    func testRestoreRequiresOnlineIdentityAndReturnsSessionBoundCredential() async throws {
        let store = AccessOnlyMemoryStore()
        let pins = try pins()
        let serverSession = session(expiry: Date().addingTimeInterval(120))
        let record = try ManagedAccessOnlyRecord(pins: pins, credential: credential(), clientID: "client-1", session: session())
        try store.save(record)
        let checked = expectation(description: "fresh server identity check")
        let restore = ManagedAccessOnlyRestore(pins: pins, store: store) { _ in checked.fulfill(); return serverSession }

        let result = try await restore.restore()
        await fulfillment(of: [checked], timeout: 1)
        XCTAssertEqual(result?.session.user.id, "staff-1")
        XCTAssertEqual(result?.clientID, "client-1")
        XCTAssertNil(result?.credential.refreshToken)
        XCTAssertLessThanOrEqual(result?.credential.expiresAt ?? .distantFuture, Date(timeIntervalSince1970: TimeInterval(serverSession.expiresAt)))
    }

    func testAuthorizationDenialRemovesSavedCredential() async throws {
        let store = AccessOnlyMemoryStore()
        let pins = try pins()
        try store.save(ManagedAccessOnlyRecord(pins: pins, credential: credential(), clientID: "client-1", session: session()))
        let restore = ManagedAccessOnlyRestore(pins: pins, store: store) { _ in throw MobilePilotError.denied }
        do { _ = try await restore.restore(); XCTFail("denied identity must not restore") }
        catch let error as MobilePilotError { XCTAssertEqual(error, .denied) }
        XCTAssertFalse(store.hasItem)
    }

    func testNetworkFailureKeepsAccessRecordButReturnsNoSession() async throws {
        let store = AccessOnlyMemoryStore()
        let pins = try pins()
        try store.save(ManagedAccessOnlyRecord(pins: pins, credential: credential(), clientID: "client-1", session: session()))
        let restore = ManagedAccessOnlyRestore(pins: pins, store: store) { _ in throw URLError(.notConnectedToInternet) }
        do { _ = try await restore.restore(); XCTFail("offline identity must fail closed") }
        catch { XCTAssertTrue(store.hasItem) }
    }

    func testRefreshTokenCannotBeSaved() throws {
        XCTAssertThrowsError(try ManagedAccessOnlyRecord(pins: pins(), credential: credential(refresh: "oauth:refresh-token"),
            clientID: "client-1", session: session()))
    }

    func testMismatchedResourceCannotRestoreSavedCredential() async throws {
        let store = AccessOnlyMemoryStore()
        try store.save(ManagedAccessOnlyRecord(pins: pins(), credential: credential(), clientID: "client-1", session: session()))
        let restore = ManagedAccessOnlyRestore(pins: try pins(resource: "https://other.example.test"), store: store) { _ in
            XCTFail("wrong resource must not reach the network")
            return self.session()
        }
        do { _ = try await restore.restore(); XCTFail("wrong resource must fail") }
        catch { XCTAssertFalse(store.hasItem) }
    }

    func testSignOutDuringOnlineRestorePreventsCredentialReturn() async throws {
        let store = AccessOnlyMemoryStore()
        let pins = try pins()
        try store.save(ManagedAccessOnlyRecord(pins: pins, credential: credential(), clientID: "client-1", session: session()))
        let gate = AccessIdentityGate()
        let restore = ManagedAccessOnlyRestore(pins: pins, store: store) { _ in try await gate.verify() }
        let task = Task { try await restore.restore() }
        await gate.waitUntilStarted()
        let cleared = await restore.signOut()
        XCTAssertTrue(cleared)
        await gate.resume(with: session())
        do { _ = try await task.value; XCTFail("sign-out must invalidate an in-flight restore") }
        catch let error as MobilePilotError { XCTAssertEqual(error, .signedOut) }
        XCTAssertFalse(store.hasItem)
    }
}
