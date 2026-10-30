import Foundation
#if canImport(CryptoKit) && canImport(Security)
import CryptoKit
import Security
#endif

/// Experimental and deliberately unmounted. A caller must only supply reviewed
/// pins and a system authentication browser after the provider callback is proven.
public struct ManagedOAuthProof: Sendable {
    public let state: String
    public let verifier: String
    public let challenge: String
    public init(state: String, verifier: String, challenge: String) {
        self.state = state; self.verifier = verifier; self.challenge = challenge
    }
}

public protocol ManagedOAuthExchanging: Sendable {
    func verifyMetadata() async throws
    func register() async throws -> String
    func exchange(code: String, verifier: String, clientID: String) async throws -> ManagedOAuthCredential
    func refresh(token: String, clientID: String) async throws -> ManagedOAuthCredential
    func revoke(token: String, clientID: String, hint: ManagedOAuthTokenKind) async throws
}
public extension ManagedOAuthExchanging {
    func refresh(token: String, clientID: String) async throws -> ManagedOAuthCredential { throw MobilePilotError.unavailable }
}
extension ManagedOAuthTransport: ManagedOAuthExchanging {}

#if canImport(CryptoKit) && canImport(Security)
/// Generates independent state and verifier with OS randomness and derives S256.
public enum ManagedOAuthProofGenerator {
    public static func generate() throws -> ManagedOAuthProof {
        func randomValue() throws -> String {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw MobilePilotError.unavailable }
            return base64(Data(bytes))
        }
        // Cloudflare currently documents an alphanumeric first challenge character.
        for _ in 0..<64 {
            let state = try randomValue(), verifier = try randomValue()
            let challenge = base64(Data(SHA256.hash(data: Data(verifier.utf8))))
            if let first = challenge.utf8.first, (48...57).contains(first) || (65...90).contains(first) || (97...122).contains(first) {
                return ManagedOAuthProof(state: state, verifier: verifier, challenge: challenge)
            }
        }
        throw MobilePilotError.unavailable
    }
    private static func base64(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
#endif

/// No credential is persisted. Provider revocation semantics remain unverified.
public enum ManagedOAuthSignOutResult: Sendable, Equatable {
    case noLocalCredential, providerAcknowledged, revocationUnconfirmed
}
public enum ManagedOAuthRevocationOutcome: Sendable, Equatable {
    case notIssued, providerAcknowledged, failed(ManagedOAuthRevocationFailure)
}
public struct ManagedOAuthRevocationOutcomes: Sendable, Equatable {
    public let refresh: ManagedOAuthRevocationOutcome
    public let access: ManagedOAuthRevocationOutcome
    public let syntheticProbe: SyntheticRevocationProbeResult?
    public init(refresh: ManagedOAuthRevocationOutcome, access: ManagedOAuthRevocationOutcome, syntheticProbe: SyntheticRevocationProbeResult? = nil) {
        self.refresh = refresh; self.access = access; self.syntheticProbe = syntheticProbe
    }
}
public enum SyntheticRevocationProbeResult: Sendable, Equatable { case accepted, rejected, inconclusive }
public struct ManagedOAuthSignOutReport: Sendable, Equatable {
    public let result: ManagedOAuthSignOutResult
    public let outcomes: ManagedOAuthRevocationOutcomes?
    public init(result: ManagedOAuthSignOutResult, outcomes: ManagedOAuthRevocationOutcomes?) {
        self.result = result; self.outcomes = outcomes
    }
}
public enum ManagedOAuthStage: Sendable, Equatable {
    case discovery, registration, browser, callback, tokenExchange, probe
}
public struct ManagedOAuthStageFailure: Error {
    public let stage: ManagedOAuthStage
    public let underlying: any Error
    public init(stage: ManagedOAuthStage, underlying: any Error) { self.stage = stage; self.underlying = underlying }
}
public enum ManagedOAuthDiagnostic {
    public static func message(for stage: ManagedOAuthStage) -> String {
        switch stage {
        case .discovery: return "Cloudflare sign-in setup could not be verified."
        case .registration: return "Cloudflare sign-in registration failed."
        case .browser: return "Cloudflare sign-in could not be completed in the browser."
        case .callback: return "The return from Cloudflare sign-in could not be verified."
        case .tokenExchange: return "Cloudflare sign-in could not complete the token exchange."
        case .probe: return "Cloudflare sign-in completed, but the test connection failed."
        }
    }
    public static func withRevocationWarning(_ message: String?) -> String {
        let warning = "Signed out on this device. Cloudflare could not confirm the session was revoked."
        guard let message, !message.isEmpty else { return warning }
        return message + " " + warning
    }
    public static func revocationDetail(_ failure: ManagedOAuthRevocationFailure?) -> String? {
        switch failure {
        case .localValidation: return "The sign-out request failed local validation."
        case .httpUnauthorized: return "The sign-out endpoint returned HTTP 401."
        case .httpStatus(let status):
            guard [400, 403, 404, 405, 409, 415, 422, 429].contains(status) else { return "The sign-out endpoint returned an HTTP 4xx error." }
            return "The sign-out endpoint returned HTTP \(status)."
        case .httpClientError: return "The sign-out endpoint returned an HTTP 4xx error."
        case .httpServerError: return "The sign-out endpoint returned an HTTP 5xx error."
        case .redirect: return "The sign-out endpoint redirected the request."
        case .network: return "The sign-out request failed due to a network error."
        case .invalidResponse: return "The sign-out endpoint returned an unexpected response."
        case nil: return nil
        }
    }
    public static func revocationOutcomes(_ outcomes: ManagedOAuthRevocationOutcomes?) -> String? {
        guard let outcomes else { return nil }
        if outcomes.refresh == .providerAcknowledged,
           outcomes.access == .failed(.httpStatus(400)), outcomes.syntheticProbe == .rejected {
            return "Cloudflare acknowledged the refresh sign-out request, and the test connection received a 401 afterward. The separate access-token sign-out request returned HTTP 400."
        }
        func describe(_ label: String, _ outcome: ManagedOAuthRevocationOutcome) -> String {
            switch outcome {
            case .notIssued: return "\(label): not issued."
            case .providerAcknowledged: return "\(label): request acknowledged."
            case .failed(let failure): return "\(label): \(revocationDetail(failure) ?? "Request failed.")"
            }
        }
        let probe: String
        switch outcomes.syntheticProbe {
        case .accepted: probe = " Test access remained usable after refresh sign-out."
        case .rejected: probe = " Test access received a 401 after refresh sign-out."
        case .inconclusive: probe = " Test access check was inconclusive."
        case nil: probe = ""
        }
        return describe("Refresh grant", outcomes.refresh) + " " + describe("Access token", outcomes.access) + probe
    }
}
public actor ManagedOAuthCoordinator {
    public typealias Browser = @Sendable (URL) async throws -> URL
    public typealias ProofFactory = @Sendable () throws -> ManagedOAuthProof
    private let pins: ManagedOAuthPins
    private let transport: any ManagedOAuthExchanging
    private let browser: Browser
    private let proofFactory: ProofFactory
    private var generation: UInt64 = 0
    private var credential: ManagedOAuthCredential?
    private var credentialClientID: String?
    private var exchangesInFlight = 0
    private var revocationsInFlight = 0
    private var grantStatusUncertain = false

    public init(pins: ManagedOAuthPins, transport: any ManagedOAuthExchanging, browser: @escaping Browser,
                proofFactory: @escaping ProofFactory) {
        self.pins = pins; self.transport = transport; self.browser = browser; self.proofFactory = proofFactory
    }
    /// Clear local access immediately; RFC 7009's 200 is an acknowledgement,
    /// not evidence that a token existed or that dependent access was revoked.
    public func signOut() async -> ManagedOAuthSignOutResult {
        await signOutReport().result
    }
    /// Explicit destructive experiment for the isolated synthetic resource.
    /// Transfers the in-memory grant out of the active session before testing.
    public func runSyntheticRefreshExperiment() async -> SyntheticRefreshReport {
        guard pins.resource == SyntheticRefreshExperiment.resource,
              let experimental = transport as? any SyntheticRefreshTransport,
              exchangesInFlight == 0, revocationsInFlight == 0,
              let old = credential, let client = credentialClientID else {
            return SyntheticRefreshReport(observation: .inconclusive, cleanupUnconfirmed: true)
        }
        generation &+= 1
        credential = nil; credentialClientID = nil
        revocationsInFlight += 1
        defer { revocationsInFlight -= 1 }
        // An experiment intentionally replays a token. Never silently reuse
        // this grant or interpret a cleanup acknowledgement as global logout.
        grantStatusUncertain = true
        return await SyntheticRefreshExperiment.run(pins: pins, credential: old, clientID: client, transport: experimental)
    }
    public func signOutReport(syntheticCheck: (@Sendable (ManagedOAuthCredential) async -> SyntheticRevocationProbeResult)? = nil) async -> ManagedOAuthSignOutReport {
        generation &+= 1
        let old = credential, client = credentialClientID
        credential = nil
        credentialClientID = nil
        let uncertain = grantStatusUncertain || exchangesInFlight > 0 || revocationsInFlight > 0
        guard let old, let client else {
            return ManagedOAuthSignOutReport(result: uncertain ? .revocationUnconfirmed : .noLocalCredential, outcomes: nil)
        }
        revocationsInFlight += 1
        defer { revocationsInFlight -= 1 }
        // Test only, supplied exclusively by the fixed synthetic app mode. A
        // baseline success is required before a later denial has meaning.
        let probeCredential = ManagedOAuthCredential(accessToken: old.accessToken, refreshToken: nil, expiresAt: old.expiresAt)
        let baseline = old.refreshToken != nil ? await syntheticCheck?(probeCredential) : nil
        var refreshOutcome: ManagedOAuthRevocationOutcome = .notIssued
        if let refresh = old.refreshToken {
            do { try await transport.revoke(token: refresh, clientID: client, hint: .refresh); refreshOutcome = .providerAcknowledged }
            catch { refreshOutcome = .failed(error as? ManagedOAuthRevocationFailure ?? .invalidResponse) }
        }
        var probe: SyntheticRevocationProbeResult?
        if syntheticCheck != nil && old.refreshToken != nil {
            if baseline == .accepted, refreshOutcome == .providerAcknowledged, let syntheticCheck {
                probe = await syntheticCheck(probeCredential)
            } else { probe = .inconclusive }
        }
        let accessOutcome: ManagedOAuthRevocationOutcome
        do { try await transport.revoke(token: old.accessToken, clientID: client, hint: .access); accessOutcome = .providerAcknowledged }
        catch { accessOutcome = .failed(error as? ManagedOAuthRevocationFailure ?? .invalidResponse) }
        let outcomes = ManagedOAuthRevocationOutcomes(refresh: refreshOutcome, access: accessOutcome, syntheticProbe: probe)
        let failed = { if case .failed = refreshOutcome { return true }; if case .failed = accessOutcome { return true }; return false }()
        if failed { grantStatusUncertain = true }
        return ManagedOAuthSignOutReport(result: failed || uncertain ? .revocationUnconfirmed : .providerAcknowledged, outcomes: outcomes)
    }
    private func check(_ expected: UInt64) throws {
        try Task.checkCancellation()
        guard generation == expected else { throw MobilePilotError.signedOut }
    }
    public func signIn() async throws {
        // Expired access cannot be reused. The caller must sign out first so
        // its in-memory refresh grant receives a revocation attempt.
        if let existing = credential {
            throw existing.expiresAt <= Date() ? MobilePilotError.expired : MobilePilotError.unavailable
        }
        generation &+= 1
        let expected = generation
        credential = nil
        let proof = try proofFactory()
        guard MobilePilotConfiguration.isBase64URL(proof.verifier, range: 43...128),
              MobilePilotConfiguration.isBase64URL(proof.state, range: 32...128), proof.state != proof.verifier else {
            throw MobilePilotError.invalidCallback
        }
        do { try await transport.verifyMetadata() } catch is CancellationError { throw CancellationError() } catch { throw ManagedOAuthStageFailure(stage: .discovery, underlying: error) }
        try check(expected)
        let client: String
        do { client = try await transport.register() } catch is CancellationError { throw CancellationError() } catch { throw ManagedOAuthStageFailure(stage: .registration, underlying: error) }
        try check(expected)
        let authorization = try ManagedOAuthWire.authorizationURL(pins: pins, clientID: client, state: proof.state, challenge: proof.challenge)
        let callback: URL
        do { callback = try await browser(authorization) } catch is CancellationError { throw CancellationError() } catch { throw ManagedOAuthStageFailure(stage: .browser, underlying: error) }
        try check(expected)
        let code: String
        do { code = try ManagedOAuthWire.callbackCode(callback, state: proof.state) } catch { throw ManagedOAuthStageFailure(stage: .callback, underlying: error) }
        exchangesInFlight += 1
        let received: ManagedOAuthCredential
        do {
            received = try await transport.exchange(code: code, verifier: proof.verifier, clientID: client)
            exchangesInFlight -= 1
        } catch {
            exchangesInFlight -= 1
            // A network error or cancellation cannot prove whether the server
            // issued a grant before its response was lost.
            grantStatusUncertain = true
            if error is CancellationError { throw error }
            throw ManagedOAuthStageFailure(stage: .tokenExchange, underlying: error)
        }
        do {
            try check(expected)
            guard received.expiresAt > Date() else { throw MobilePilotError.expired }
        } catch {
            grantStatusUncertain = true
            // A code exchange can finish after sign-out. Attempt to revoke the
            // issued grant without reinstalling it; never claim this succeeded.
            let transport = self.transport
            await Task.detached {
                if let refresh = received.refreshToken { try? await transport.revoke(token: refresh, clientID: client, hint: .refresh) }
                try? await transport.revoke(token: received.accessToken, clientID: client, hint: .access)
            }.value
            throw error
        }
        credential = received
        credentialClientID = client
    }
    public func currentAccessToken() -> String? {
        guard let credential, credential.expiresAt > Date() else { return nil }
        return credential.accessToken
    }
    /// Only the access token is exposed to the read-only data transport.
    public func currentDataCredential() -> ManagedOAuthCredential? {
        guard let credential, credential.expiresAt > Date() else { return nil }
        return ManagedOAuthCredential(accessToken: credential.accessToken, refreshToken: nil, expiresAt: credential.expiresAt)
    }
}
