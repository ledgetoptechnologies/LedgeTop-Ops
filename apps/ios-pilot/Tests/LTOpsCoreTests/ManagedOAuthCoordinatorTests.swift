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
private actor RevocationLog {
    private var kinds: [ManagedOAuthTokenKind] = []
    func add(_ kind: ManagedOAuthTokenKind) { kinds.append(kind) }
    func snapshot() -> [ManagedOAuthTokenKind] { kinds }
}
private actor ProbeLog {
    var count = 0
    func check(_ value: ManagedOAuthCredential, log: RevocationLog) async -> SyntheticRevocationProbeResult {
        guard value.refreshToken == nil, value.accessToken == "oauth:synthetic" else { return .inconclusive }
        let kinds = await log.snapshot()
        count += 1
        if count == 1 { return kinds.isEmpty ? .accepted : .inconclusive }
        return kinds == [.refresh] ? .rejected : .inconclusive
    }
}
private struct FakeExchange: ManagedOAuthExchanging {
    let gate: ExchangeGate?
    var failRevocation = false
    var log: RevocationLog? = nil
    var failExchange = false
    var lifetime: TimeInterval = 300
    var failKind: ManagedOAuthTokenKind? = nil
    var noRefresh = false
    var revokeGate: ExchangeGate? = nil
    func verifyMetadata() async throws {}
    func register() async throws -> String { "client-id" }
    func exchange(code: String, verifier: String, clientID: String) async throws -> ManagedOAuthCredential {
        if let gate { await gate.pause() }
        if failExchange { throw URLError(.networkConnectionLost) }
        guard code == "code", verifier == String(repeating: "v", count: 43), clientID == "client-id" else { throw MobilePilotError.invalidResponse }
        return ManagedOAuthCredential(accessToken: "oauth:synthetic", refreshToken: noRefresh ? nil : "oauth:refresh", expiresAt: Date().addingTimeInterval(lifetime))
    }
    func revoke(token: String, clientID: String, hint: ManagedOAuthTokenKind) async throws {
        await log?.add(hint)
        if hint == .refresh, let revokeGate { await revokeGate.pause() }
        if failRevocation { throw MobilePilotError.unavailable }
        if hint == failKind { throw ManagedOAuthRevocationFailure.httpStatus(400) }
        guard clientID == "client-id", (hint == .refresh && token == "oauth:refresh") || (hint == .access && token == "oauth:synthetic") else { throw MobilePilotError.invalidResponse }
    }
}
final class ManagedOAuthCoordinatorTests: XCTestCase {
    private func pins() throws -> ManagedOAuthPins {
        try ManagedOAuthPins(resource: "https://pilot.example.test", issuer: "https://team.cloudflareaccess.com",
            authorizationEndpoint: "https://team.cloudflareaccess.com/auth", tokenEndpoint: "https://team.cloudflareaccess.com/token",
            registrationEndpoint: "https://team.cloudflareaccess.com/register", revocationEndpoint: "https://team.cloudflareaccess.com/revoke")
    }
    private func coordinator(gate: ExchangeGate? = nil, mismatch: Bool = false, failRevocation: Bool = false, log: RevocationLog? = nil, failExchange: Bool = false, lifetime: TimeInterval = 300, failKind: ManagedOAuthTokenKind? = nil, noRefresh: Bool = false, revokeGate: ExchangeGate? = nil) throws -> ManagedOAuthCoordinator {
        try ManagedOAuthCoordinator(pins: pins(), transport: FakeExchange(gate: gate, failRevocation: failRevocation, log: log, failExchange: failExchange, lifetime: lifetime, failKind: failKind, noRefresh: noRefresh, revokeGate: revokeGate), browser: { url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: ManagedOAuthWire.callback + "?code=code&state=" + (mismatch ? String(repeating: "x", count: 43) : state))!
        }, proofFactory: { ManagedOAuthProof(state: String(repeating: "s", count: 43), verifier: String(repeating: "v", count: 43), challenge: String(repeating: "A", count: 43)) })
    }
    func testSyntheticSignOutChecksBeforeAndAfterRefreshThenRevokesAccess() async throws {
        let log = RevocationLog(), probe = ProbeLog(), coordinator = try coordinator(log: log, failKind: .access)
        try await coordinator.signIn()
        let report = await coordinator.signOutReport(syntheticCheck: { await probe.check($0, log: log) })
        XCTAssertEqual(report.outcomes?.syntheticProbe, .rejected)
        XCTAssertEqual(report.result, .revocationUnconfirmed)
        let kinds = await log.snapshot()
        XCTAssertEqual(kinds, [.refresh, .access])
        let message = ManagedOAuthDiagnostic.revocationOutcomes(report.outcomes) ?? ""
        XCTAssertTrue(message.contains("received a 401"))
        XCTAssertFalse(message.contains("oauth:"))
    }
    func testSyntheticProbeIsInconclusiveIfBaselineOrRefreshFails() async throws {
        for failRefresh in [false, true] {
            let log = RevocationLog(), coordinator = try coordinator(log: log, failKind: failRefresh ? .refresh : nil)
            try await coordinator.signIn()
            let report = await coordinator.signOutReport(syntheticCheck: { _ in failRefresh ? .accepted : .inconclusive })
            XCTAssertEqual(report.outcomes?.syntheticProbe, .inconclusive)
            let kinds = await log.snapshot()
            XCTAssertEqual(kinds, [.refresh, .access])
        }
    }
    func testOverlappingSignOutDoesNotAttributeAnotherAttemptsOutcomes() async throws {
        let gate = ExchangeGate(), coordinator = try coordinator(failKind: .refresh, revokeGate: gate)
        try await coordinator.signIn()
        let first = Task { await coordinator.signOutReport() }
        await gate.waitUntilHeld()
        let second = await coordinator.signOutReport()
        XCTAssertEqual(second.result, .revocationUnconfirmed)
        XCTAssertNil(second.outcomes)
        await gate.release()
        let firstReport = await first.value
        XCTAssertEqual(firstReport.outcomes?.refresh, .failed(.httpStatus(400)))
        XCTAssertEqual(firstReport.outcomes?.access, .providerAcknowledged)
    }
    func testRevocationReportHasNoRefreshWhenNotIssued() async throws {
        let coordinator = try coordinator(failKind: .access, noRefresh: true)
        try await coordinator.signIn()
        let report = await coordinator.signOutReport()
        XCTAssertEqual(report.result, .revocationUnconfirmed)
        XCTAssertEqual(report.outcomes?.refresh, .notIssued)
        XCTAssertEqual(report.outcomes?.access, .failed(.httpStatus(400)))
    }
    func testRevocationReportsEachTokenOutcomeSeparately() async throws {
        for kind in [ManagedOAuthTokenKind.refresh, .access] {
            let coordinator = try coordinator(failKind: kind)
            try await coordinator.signIn()
            let report = await coordinator.signOutReport()
            XCTAssertEqual(report.result, .revocationUnconfirmed)
            let outcomes = report.outcomes
            XCTAssertEqual(outcomes?.refresh, kind == .refresh ? .failed(.httpStatus(400)) : .providerAcknowledged)
            XCTAssertEqual(outcomes?.access, kind == .access ? .failed(.httpStatus(400)) : .providerAcknowledged)
            let message = ManagedOAuthDiagnostic.revocationOutcomes(outcomes) ?? ""
            XCTAssertTrue(message.contains("HTTP 400"))
            XCTAssertFalse(message.contains("oauth:"))
            XCTAssertFalse(message.contains("client-id"))
            let later = await coordinator.signOutReport()
            XCTAssertEqual(later.result, .revocationUnconfirmed)
            XCTAssertNil(later.outcomes)
        }
    }
    func testSignInAndSignOutAreMemoryOnly() async throws {
        let coordinator = try coordinator()
        try await coordinator.signIn()
        let token = await coordinator.currentAccessToken()
        XCTAssertEqual(token, "oauth:synthetic")
        let dataCredential = await coordinator.currentDataCredential()
        XCTAssertEqual(dataCredential?.accessToken, "oauth:synthetic")
        XCTAssertNil(dataCredential?.refreshToken)
        let result = await coordinator.signOut()
        XCTAssertEqual(result, .providerAcknowledged)
        let cleared = await coordinator.currentAccessToken()
        XCTAssertNil(cleared)
        let clearedDataCredential = await coordinator.currentDataCredential()
        XCTAssertNil(clearedDataCredential)
    }
    func testWrongStateDoesNotInstallCredential() async throws {
        let coordinator = try coordinator(mismatch: true)
        do { try await coordinator.signIn(); XCTFail("must reject wrong state") } catch {
            let failure = error as? ManagedOAuthStageFailure
            XCTAssertEqual(failure?.stage, .callback)
            XCTAssertEqual(failure?.underlying as? MobilePilotError, .invalidCallback)
        }
        let token = await coordinator.currentAccessToken()
        XCTAssertNil(token)
    }
    func testSignOutWhileExchangeIsPendingDiscardsLateCredential() async throws {
        let gate = ExchangeGate(), log = RevocationLog(), coordinator = try coordinator(gate: gate, log: log)
        let task = Task { try await coordinator.signIn() }
        await gate.waitUntilHeld()
        let result = await coordinator.signOut()
        XCTAssertEqual(result, .revocationUnconfirmed)
        await gate.release()
        do { try await task.value; XCTFail("must discard late credential") } catch { XCTAssertEqual(error as? MobilePilotError, .signedOut) }
        let token = await coordinator.currentAccessToken()
        XCTAssertNil(token)
        let revoked = await log.snapshot()
        XCTAssertEqual(revoked, [.refresh, .access])
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
        let status = await coordinator.signOut()
        XCTAssertEqual(status, .revocationUnconfirmed)
    }
    func testOfflineSignOutClearsLocalCredentialAndReportsUnconfirmed() async throws {
        let log = RevocationLog(), coordinator = try coordinator(failRevocation: true, log: log)
        try await coordinator.signIn()
        let result = await coordinator.signOut()
        XCTAssertEqual(result, .revocationUnconfirmed)
        let token = await coordinator.currentAccessToken()
        XCTAssertNil(token)
        let attempted = await log.snapshot()
        XCTAssertEqual(attempted, [.refresh, .access])
    }
    func testLostExchangeResponseMakesSignOutUnconfirmed() async throws {
        let coordinator = try coordinator(failExchange: true)
        do { try await coordinator.signIn(); XCTFail("must fail") } catch {
            XCTAssertEqual((error as? ManagedOAuthStageFailure)?.stage, .tokenExchange)
        }
        let result = await coordinator.signOut()
        XCTAssertEqual(result, .revocationUnconfirmed)
    }
    func testDiagnosticPreservesPrimaryFailureAlongsideRevocationWarning() {
        let primary = ManagedOAuthDiagnostic.message(for: .tokenExchange)
        let combined = ManagedOAuthDiagnostic.withRevocationWarning(primary)
        XCTAssertTrue(combined.contains(primary))
        XCTAssertTrue(combined.contains("Cloudflare could not confirm the session was revoked"))
        XCTAssertNotEqual(ManagedOAuthDiagnostic.message(for: .probe), primary)
    }
    func testExpiredAccessRequiresSignOutBeforeAnotherSignIn() async throws {
        let log = RevocationLog(), coordinator = try coordinator(log: log, lifetime: 0.1)
        try await coordinator.signIn()
        try await Task.sleep(nanoseconds: 250_000_000)
        do { try await coordinator.signIn(); XCTFail("expired grant must be signed out first") }
        catch { XCTAssertEqual(error as? MobilePilotError, .expired) }
        let result = await coordinator.signOut()
        XCTAssertEqual(result, .providerAcknowledged)
        let attempted = await log.snapshot()
        XCTAssertEqual(attempted, [.refresh, .access])
        try await coordinator.signIn()
    }
}
