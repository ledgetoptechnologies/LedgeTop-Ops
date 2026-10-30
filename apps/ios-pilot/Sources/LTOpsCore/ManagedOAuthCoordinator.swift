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

/// No credential is persisted. This does not revoke Cloudflare grants: activation
/// requires verified provider revocation and a user-visible sign-out contract.
public actor ManagedOAuthCoordinator {
    public typealias Browser = @Sendable (URL) async throws -> URL
    public typealias ProofFactory = @Sendable () throws -> ManagedOAuthProof
    private let pins: ManagedOAuthPins
    private let transport: any ManagedOAuthExchanging
    private let browser: Browser
    private let proofFactory: ProofFactory
    private var generation: UInt64 = 0
    private var credential: ManagedOAuthCredential?

    public init(pins: ManagedOAuthPins, transport: any ManagedOAuthExchanging, browser: @escaping Browser,
                proofFactory: @escaping ProofFactory) {
        self.pins = pins; self.transport = transport; self.browser = browser; self.proofFactory = proofFactory
    }
    public func signOut() {
        generation &+= 1
        credential = nil
    }
    private func check(_ expected: UInt64) throws {
        try Task.checkCancellation()
        guard generation == expected else { throw MobilePilotError.signedOut }
    }
    public func signIn() async throws {
        generation &+= 1
        let expected = generation
        credential = nil
        let proof = try proofFactory()
        guard MobilePilotConfiguration.isBase64URL(proof.verifier, range: 43...128),
              MobilePilotConfiguration.isBase64URL(proof.state, range: 32...128), proof.state != proof.verifier else {
            throw MobilePilotError.invalidCallback
        }
        try await transport.verifyMetadata(); try check(expected)
        let client = try await transport.register(); try check(expected)
        let authorization = try ManagedOAuthWire.authorizationURL(pins: pins, clientID: client, state: proof.state, challenge: proof.challenge)
        let callback = try await browser(authorization); try check(expected)
        let code = try ManagedOAuthWire.callbackCode(callback, state: proof.state)
        let received = try await transport.exchange(code: code, verifier: proof.verifier, clientID: client)
        try check(expected)
        guard received.expiresAt > Date() else { throw MobilePilotError.expired }
        // Deliberately discard refresh tokens until revocation has been verified.
        credential = ManagedOAuthCredential(accessToken: received.accessToken, refreshToken: nil, expiresAt: received.expiresAt)
    }
    public func currentAccessToken() -> String? {
        guard let credential, credential.expiresAt > Date() else { self.credential = nil; return nil }
        return credential.accessToken
    }
}
