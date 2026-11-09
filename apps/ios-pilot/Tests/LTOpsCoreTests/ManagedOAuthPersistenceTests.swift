import Foundation
import XCTest
@testable import LTOpsCore

private final class MemoryGrantStore: ManagedOAuthGrantStore, @unchecked Sendable {
    private let lock = NSLock()
    private var item: ManagedOAuthStoredGrant?
    var failLoad = false
    var failClear = false
    var failSaveAfterWrite = false
    func load() throws -> ManagedOAuthStoredGrant? {
        lock.lock(); defer { lock.unlock() }
        if failLoad { throw ManagedOAuthStoreError.unavailable }
        return item
    }
    func save(_ value: ManagedOAuthStoredGrant) throws {
        lock.lock(); defer { lock.unlock() }; item = value
        if failSaveAfterWrite { throw ManagedOAuthStoreError.unavailable }
    }
    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        if failClear { throw ManagedOAuthStoreError.unavailable }
        item = nil
    }
}
private actor RefreshGate {
    private var waiting: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func hold() async { await withCheckedContinuation { c in waiting = c; entered?.resume(); entered = nil } }
    func wait() async { if waiting != nil { return }; await withCheckedContinuation { entered = $0 } }
    func release() { waiting?.resume(); waiting = nil }
}
private actor RefreshLog {
    var calls = 0
    var revoked: [ManagedOAuthTokenKind] = []
    func didRefresh() { calls += 1 }
    func didRevoke(_ kind: ManagedOAuthTokenKind) { revoked.append(kind) }
}
private struct RefreshTransport: ManagedOAuthExchanging {
    let log: RefreshLog
    var gate: RefreshGate?
    var revokeGate: RefreshGate?
    var failRefresh = false
    func verifyMetadata() async throws {}
    func register() async throws -> String { "client-id" }
    func exchange(code: String, verifier: String, clientID: String) async throws -> ManagedOAuthCredential { throw MobilePilotError.unavailable }
    func refresh(token: String, clientID: String) async throws -> ManagedOAuthCredential {
        await log.didRefresh()
        if let gate { await gate.hold() }
        if failRefresh { throw URLError(.networkConnectionLost) }
        guard token == "oauth:old", clientID == "client-id" else { throw MobilePilotError.invalidResponse }
        return ManagedOAuthCredential(accessToken: "oauth:access", refreshToken: "oauth:rotated", expiresAt: Date().addingTimeInterval(300))
    }
    func revoke(token: String, clientID: String, hint: ManagedOAuthTokenKind) async throws {
        await log.didRevoke(hint)
        if hint == .refresh, let revokeGate { await revokeGate.hold() }
    }
}
final class ManagedOAuthPersistenceTests: XCTestCase, @unchecked Sendable {
    private func pins(_ host: String = "pilot.example.test") throws -> ManagedOAuthPins {
        try ManagedOAuthPins(resource: "https://" + host, issuer: "https://team.cloudflareaccess.com",
            authorizationEndpoint: "https://team.cloudflareaccess.com/auth", tokenEndpoint: "https://team.cloudflareaccess.com/token",
            registrationEndpoint: "https://team.cloudflareaccess.com/register", revocationEndpoint: "https://team.cloudflareaccess.com/revoke")
    }
    private func seed(_ store: MemoryGrantStore) throws {
        try store.save(ManagedOAuthStoredGrant(pins: pins(), clientID: "client-id", refreshToken: "oauth:old"))
    }
    func testRestoreAfterNewCoordinatorRotatesStoredGrantWithoutExposingRefreshToken() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(); try seed(store)
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        let credential = try await session.restore()
        XCTAssertEqual(credential?.accessToken, "oauth:access")
        XCTAssertNil(credential?.refreshToken)
        XCTAssertEqual(try store.load()?.refreshToken, "oauth:rotated")
        let signOut = await session.signOut(); XCTAssertEqual(signOut, .providerAcknowledged)
        XCTAssertNil(try store.load())
        let restarted = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        let absent = try await restarted.restore(); XCTAssertNil(absent)
    }
    func testLostRefreshResponseClearsStoredGrantAndDoesNotRetry() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(); try seed(store)
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log, failRefresh: true), store: store)
        do { _ = try await session.restore(); XCTFail("Expected failure") } catch {}
        XCTAssertNil(try store.load())
        let result = try await session.restore(); XCTAssertNil(result)
        let count = await log.calls; XCTAssertEqual(count, 1)
        let status = await session.signOut(); XCTAssertEqual(status, .revocationUnconfirmed)
    }
    func testSignOutWhileRefreshPendingDoesNotResurrectGrant() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(), gate = RefreshGate(); try seed(store)
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log, gate: gate), store: store)
        let task = Task { try await session.restore() }
        await gate.wait()
        // Simulate another process starting while the refresh response is lost.
        let restarted = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        let unavailable = try await restarted.restore(); XCTAssertNil(unavailable)
        let status = await session.signOut(); XCTAssertEqual(status, .revocationUnconfirmed)
        await gate.release()
        do { _ = try await task.value; XCTFail("Must not restore after sign-out") } catch {}
        XCTAssertNil(try store.load())
        let revoked = await log.revoked; XCTAssertEqual(revoked, [.refresh, .refresh, .access])
    }
    func testDeleteFailurePreventsDispatchingRefresh() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(); try seed(store); store.failClear = true
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        do { _ = try await session.restore(); XCTFail("Must fail before refresh") } catch {}
        let count = await log.calls; XCTAssertEqual(count, 0)
        XCTAssertNotNil(try store.load())
    }
    func testStoreUnavailableIsNotTreatedAsMissingAndFailedDeleteIsNotConfirmed() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(); try seed(store); store.failLoad = true
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        do { _ = try await session.restore(); XCTFail("Must surface unavailable Keychain") } catch {}
        store.failLoad = false; store.failClear = true
        let status = await session.signOut(); XCTAssertEqual(status, .localRemovalUnconfirmed)
        XCTAssertNotNil(try store.load())
    }
    func testGrantCannotBeUsedForDifferentResource() throws {
        let store = MemoryGrantStore(); try seed(store)
        XCTAssertThrowsError(try store.load()?.validate(pins: pins("other.example.test")))
    }
    func testRetainCannotOverwriteExistingGrant() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(); try seed(store)
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        let new = ManagedOAuthCredential(accessToken: "oauth:new-access", refreshToken: "oauth:new-refresh", expiresAt: Date().addingTimeInterval(300))
        do { try await session.retain(credential: new, clientID: "client-id"); XCTFail("Must not overwrite old grant") } catch {}
        XCTAssertEqual(try store.load()?.refreshToken, "oauth:old")
    }
    func testFailedLocalRemovalCannotRestoreGrantUntilSignOutRetriesDeletion() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(); try seed(store)
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        store.failClear = true
        let failure = await session.signOut()
        XCTAssertEqual(failure, .localRemovalUnconfirmed)
        store.failClear = false
        do { _ = try await session.restore(); XCTFail("A failed local sign-out must not restore the grant") } catch {}
        let callsBeforeRetry = await log.calls; XCTAssertEqual(callsBeforeRetry, 0)
        let retry = await session.signOut(); XCTAssertEqual(retry, .revocationUnconfirmed)
        XCTAssertNil(try store.load())
        let absent = try await session.restore(); XCTAssertNil(absent)
    }
    func testOverlappingSignOutCannotClaimNoCredentialWhileRevocationIsPending() async throws {
        let store = MemoryGrantStore(), log = RefreshLog(), gate = RefreshGate(); try seed(store)
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log, revokeGate: gate), store: store)
        let first = Task { await session.signOut() }
        await gate.wait()
        let second = await session.signOut(); XCTAssertEqual(second, .revocationUnconfirmed)
        do { _ = try await session.restore(); XCTFail("Must not restore while revocation is pending") } catch {}
        let new = ManagedOAuthCredential(accessToken: "oauth:new-access", refreshToken: "oauth:new-refresh", expiresAt: Date().addingTimeInterval(300))
        do { try await session.retain(credential: new, clientID: "client-id"); XCTFail("Must not retain while revocation is pending") } catch {}
        await gate.release()
        let firstResult = await first.value; XCTAssertEqual(firstResult, .providerAcknowledged)
    }
    func testAmbiguousSaveDoesNotRestoreUntilExplicitCleanup() async throws {
        let store = MemoryGrantStore(), log = RefreshLog()
        let session = try ManagedOAuthPersistence(pins: pins(), transport: RefreshTransport(log: log), store: store)
        let new = ManagedOAuthCredential(accessToken: "oauth:new-access", refreshToken: "oauth:new-refresh", expiresAt: Date().addingTimeInterval(300))
        store.failSaveAfterWrite = true
        do { try await session.retain(credential: new, clientID: "client-id"); XCTFail("Write should fail") } catch {}
        store.failSaveAfterWrite = false
        XCTAssertNotNil(try store.load())
        do { _ = try await session.restore(); XCTFail("An ambiguous write cannot be restored") } catch {}
        let calls = await log.calls; XCTAssertEqual(calls, 0)
        let status = await session.signOut(); XCTAssertEqual(status, .revocationUnconfirmed)
        XCTAssertNil(try store.load())
    }
}
