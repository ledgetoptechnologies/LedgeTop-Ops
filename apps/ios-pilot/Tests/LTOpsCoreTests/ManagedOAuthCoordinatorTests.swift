import Foundation
import XCTest
@testable import LTOpsCore

private actor ExchangeGate {
    private var held: CheckedContinuation<Void, Never>?
    private var waiting: CheckedContinuation<Void, Never>?
    func pause() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            held = continuation; waiting?.resume(); waiting = nil
        }
    }
    func waitUntilHeld() async {
        if held != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func release() { held?.resume(); held = nil }
}
private struct FakeExchange: ManagedOAuthExchanging {
    let gate: ExchangeGate?
    func verifyMetadata() async throws {}
    func register() async throws -> String { "client-id" }
    func exchange(code: String, verifier: String, clientID: String) async throws -> ManagedOAuthCredential {
        if let gate { await gate.pause() }
        guard code == "code", verifier == String(repeating: "v", count: 43), clientID == "client-id" else { throw MobilePilotError.invalidResponse }
        return ManagedOAuthCredential(accessToken: "oauth:synthetic", refreshToken: "oauth:refresh", expiresAt: Date().addingTimeInterval(300))
    }
}
final class ManagedOAuthCoordinatorTests: XCTestCase {
    private func pins() throws -> ManagedOAuthPins {
        try ManagedOAuthPins(resource: "https://pilot.example.test", issuer: "https://team.cloudflareaccess.com",
            authorizationEndpoint: "https://team.cloudflareaccess.com/auth", tokenEndpoint: "https://team.cloudflareaccess.com/token",
            registrationEndpoint: "https://team.cloudflareaccess.com/register", revocationEndpoint: "https://team.cloudflareaccess.com/revoke")
    }
    private func coordinator(gate: ExchangeGate? = nil, mismatch: Bool = false) throws -> ManagedOAuthCoordinator {
        try ManagedOAuthCoordinator(pins: pins(), transport: FakeExchange(gate: gate), browser: { url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: ManagedOAuthWire.callback + "?code=code&state=" + (mismatch ? String(repeating: "x", count: 43) : state))!
        }, proofFactory: { ManagedOAuthProof(state: String(repeating: "s", count: 43), verifier: String(repeating: "v", count: 43), challenge: String(repeating: "A", count: 43)) })
    }
    func testSignInAndSignOutAreMemoryOnly() async throws {
        let coordinator = try coordinator()
        try await coordinator.signIn()
        let token = await coordinator.currentAccessToken()
        XCTAssertEqual(token, "oauth:synthetic")
        await coordinator.signOut()
        let cleared = await coordinator.currentAccessToken()
        XCTAssertNil(cleared)
    }
    func testWrongStateDoesNotInstallCredential() async throws {
        let coordinator = try coordinator(mismatch: true)
        do { try await coordinator.signIn(); XCTFail("must reject wrong state") } catch { XCTAssertEqual(error as? MobilePilotError, .invalidCallback) }
        let token = await coordinator.currentAccessToken()
        XCTAssertNil(token)
    }
    func testSignOutWhileExchangeIsPendingDiscardsLateCredential() async throws {
        let gate = ExchangeGate(), coordinator = try coordinator(gate: gate)
        let task = Task { try await coordinator.signIn() }
        await gate.waitUntilHeld()
        await coordinator.signOut()
        await gate.release()
        do { try await task.value; XCTFail("must discard late credential") } catch { XCTAssertEqual(error as? MobilePilotError, .signedOut) }
        let token = await coordinator.currentAccessToken()
        XCTAssertNil(token)
    }
    func testCancellationWhileExchangeIsPendingDiscardsLateCredential() async throws {
        let gate = ExchangeGate(), coordinator = try coordinator(gate: gate)
        let task = Task { try await coordinator.signIn() }
        await gate.waitUntilHeld()
        task.cancel()
        await gate.release()
        do { try await task.value; XCTFail("must discard cancelled credential") } catch { XCTAssertTrue(error is CancellationError) }
        let token = await coordinator.currentAccessToken()
        XCTAssertNil(token)
    }
}
