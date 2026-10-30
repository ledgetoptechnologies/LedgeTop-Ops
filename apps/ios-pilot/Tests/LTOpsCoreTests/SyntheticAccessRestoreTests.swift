import Foundation
import XCTest
@testable import LTOpsCore

private final class AccessMemoryStore: SyntheticAccessStore, @unchecked Sendable {
    private let lock = NSLock()
    private var item: SyntheticAccessRecord?
    var locked = false, corrupt = false, failClear = false, failAfterWrite = false
    func load() throws -> SyntheticAccessRecord? { lock.lock(); defer { lock.unlock() }; if locked { throw ManagedOAuthStoreError.unavailable }; if corrupt { throw ManagedOAuthStoreError.invalid }; return item }
    func save(_ value: SyntheticAccessRecord) throws { lock.lock(); defer { lock.unlock() }; item = value; if failAfterWrite { throw ManagedOAuthStoreError.unavailable } }
    func clear() throws { lock.lock(); defer { lock.unlock() }; if failClear { throw ManagedOAuthStoreError.unavailable }; item = nil; corrupt = false }
}
private actor AccessGate {
    private var waiting: CheckedContinuation<Void, Never>?
    private var ready: CheckedContinuation<Void, Never>?
    func hold() async { await withCheckedContinuation { waiting = $0; ready?.resume(); ready = nil } }
    func wait() async { if waiting != nil { return }; await withCheckedContinuation { ready = $0 } }
    func release() { waiting?.resume(); waiting = nil }
}
final class SyntheticAccessRestoreTests: XCTestCase, @unchecked Sendable {
    private func pins(_ resource: String = SyntheticRefreshExperiment.resource) throws -> ManagedOAuthPins {
        let issuer = "https://ledgetoptechnologies.cloudflareaccess.com"
        return try ManagedOAuthPins(resource: resource, issuer: issuer,
            authorizationEndpoint: issuer + "/cdn-cgi/access/oauth/authorization", tokenEndpoint: issuer + "/cdn-cgi/access/oauth/token",
            registrationEndpoint: issuer + "/cdn-cgi/access/oauth/registration", revocationEndpoint: issuer + "/cdn-cgi/access/oauth/revoke")
    }
    private func credential(_ seconds: TimeInterval = 300) -> ManagedOAuthCredential {
        ManagedOAuthCredential(accessToken: "oauth:test", refreshToken: "oauth:never-store", expiresAt: Date().addingTimeInterval(seconds))
    }
    func testRestoreRequiresFreshOnlineCheckAndStoresNoRefresh() async throws {
        let store = AccessMemoryStore()
        let original = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in }, revoke: { _, _ in })
        try await original.retain(credential(), clientID: "client")
        let bytes = try JSONEncoder().encode(store.load())
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("oauth:never-store"))
        let restarted = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in throw URLError(.notConnectedToInternet) }, revoke: { _, _ in })
        do { _ = try await restarted.restore(); XCTFail("Offline restore must fail") } catch {}
        let verified = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in }, revoke: { _, _ in })
        let result = try await verified.restore(); XCTAssertEqual(result?.accessToken, "oauth:test"); XCTAssertNil(result?.refreshToken)
    }
    func testRejectsExpiredOrLongLivedAndForeignOrigin() async throws {
        let store = AccessMemoryStore()
        let actor = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in }, revoke: { _, _ in })
        for time in [-1.0, 1200.0] { do { try await actor.retain(credential(time), clientID: "client"); XCTFail("Invalid expiry") } catch {} }
        XCTAssertThrowsError(try SyntheticAccessRestore(pins: pins("https://other.example.test"), store: store, verify: { _ in }, revoke: { _, _ in }))
        let old = try SyntheticAccessRecord(pins: pins(), credential: credential(1), clientID: "client", now: Date().addingTimeInterval(-2))
        try store.save(old)
        try await Task.sleep(for: .seconds(2))
        do { _ = try await actor.restore(); XCTFail("Expired credential") } catch {}
        XCTAssertNil(try store.load())
    }
    func testUnauthorizedOnlineCheckRemovesStoredAccess() async throws {
        let store = AccessMemoryStore()
        let actor = try SyntheticAccessRestore(pins: pins(), store: store,
            verify: { _ in throw SyntheticProbeFailure.edgeUnauthorized }, revoke: { _, _ in })
        try await actor.retain(credential(), clientID: "client")
        do { _ = try await actor.restore(); XCTFail("Denied access") } catch {}
        XCTAssertNil(try store.load())
    }
    func testLockedOrAmbiguousStoreFailsClosed() async throws {
        let store = AccessMemoryStore(), actor = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in }, revoke: { _, _ in })
        store.locked = true
        do { _ = try await actor.restore(); XCTFail("Locked is not absent") } catch {}
        store.locked = false; store.failAfterWrite = true
        do { try await actor.retain(credential(), clientID: "client"); XCTFail("Ambiguous write") } catch {}
        do { _ = try await actor.restore(); XCTFail("Cannot restore ambiguous write") } catch {}
        store.failClear = true
        let failed = await actor.signOut(); XCTAssertEqual(failed, .localRemovalUnconfirmed)
        do { _ = try await actor.restore(); XCTFail("Cannot restore after failed deletion") } catch {}
        store.failClear = false
        let cleanup = await actor.signOut(); XCTAssertEqual(cleanup, .remoteRevocationUnconfirmed)
        XCTAssertNil(try store.load())
    }
    func testSignOutDuringOnlineCheckPreventsCredentialReturn() async throws {
        let store = AccessMemoryStore(), gate = AccessGate()
        let actor = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in await gate.hold() }, revoke: { _, _ in })
        try await actor.retain(credential(), clientID: "client")
        let task = Task { try await actor.restore() }; await gate.wait()
        let result = await actor.signOut(); XCTAssertEqual(result, .remoteRevocationUnconfirmed)
        await gate.release()
        do { _ = try await task.value; XCTFail("Signed-out token returned") } catch {}
        XCTAssertNil(try store.load())
    }
    func testCorruptRecordIsRemovedButLockedStoreIsNotReportedRemoved() async throws {
        let store = AccessMemoryStore(), actor = try SyntheticAccessRestore(pins: pins(), store: store, verify: { _ in }, revoke: { _, _ in })
        store.locked = true
        let lockedResult = await actor.signOut(); XCTAssertEqual(lockedResult, .localRemovalUnconfirmed)
        store.locked = false; store.corrupt = true
        let corruptResult = await actor.signOut(); XCTAssertEqual(corruptResult, .remoteRevocationUnconfirmed)
        XCTAssertNil(try store.load())
    }
}
