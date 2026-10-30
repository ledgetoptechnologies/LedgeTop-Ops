import Foundation
#if canImport(Security)
import Security
#endif

/// Unwired, synthetic-only candidate. It never persists a refresh token or
/// data. Restarted sessions must be validated online before being returned.
public struct SyntheticAccessRecord: Codable, Sendable, Equatable {
    public let resource: String
    public let issuer: String
    public let token: String
    public let clientID: String
    public let expiresAt: Date

    public init(pins: ManagedOAuthPins, credential: ManagedOAuthCredential, clientID: String, now: Date = Date()) throws {
        guard SyntheticAccessRestore.reviewed(pins), credential.expiresAt > now,
              credential.expiresAt.timeIntervalSince(now) <= 900,
              credential.accessToken.hasPrefix("oauth:"), (7...4096).contains(credential.accessToken.utf8.count),
              credential.accessToken.utf8.allSatisfy({ (33...126).contains($0) }),
              !clientID.isEmpty, clientID.utf8.count <= 512,
              clientID.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 95, 46, 126].contains($0) }) else {
            throw MobilePilotError.invalidResponse
        }
        resource = pins.resource; issuer = pins.issuer; token = credential.accessToken
        self.clientID = clientID; expiresAt = credential.expiresAt
    }
}

public protocol SyntheticAccessStore: Sendable {
    func load() throws -> SyntheticAccessRecord?
    func save(_ value: SyntheticAccessRecord) throws
    func clear() throws
}

public enum SyntheticAccessSignOut: Equatable, Sendable {
    case noLocalCredential, localRemovalUnconfirmed, remoteRevocationUnconfirmed
}

public actor SyntheticAccessRestore {
    private let pins: ManagedOAuthPins
    private let store: any SyntheticAccessStore
    private let verify: @Sendable (ManagedOAuthCredential) async throws -> Void
    private let revoke: @Sendable (String, String) async throws -> Void
    private var generation: UInt64 = 0
    private var working = false
    private var revoking = false
    private var removalUnconfirmed = false

    static func reviewed(_ pins: ManagedOAuthPins) -> Bool {
        let issuer = "https://ledgetoptechnologies.cloudflareaccess.com"
        return pins.resource == SyntheticRefreshExperiment.resource && pins.issuer == issuer
            && pins.authorizationEndpoint == issuer + "/cdn-cgi/access/oauth/authorization"
            && pins.tokenEndpoint == issuer + "/cdn-cgi/access/oauth/token"
            && pins.registrationEndpoint == issuer + "/cdn-cgi/access/oauth/registration"
            && pins.revocationEndpoint == issuer + "/cdn-cgi/access/oauth/revoke"
    }

    public init(pins: ManagedOAuthPins, store: any SyntheticAccessStore,
                verify: @escaping @Sendable (ManagedOAuthCredential) async throws -> Void,
                revoke: @escaping @Sendable (String, String) async throws -> Void) throws {
        guard Self.reviewed(pins) else { throw MobilePilotError.invalidResponse }
        self.pins = pins; self.store = store; self.verify = verify; self.revoke = revoke
    }

    public func retain(_ credential: ManagedOAuthCredential, clientID: String) throws {
        guard !working, !revoking, !removalUnconfirmed, try store.load() == nil else { throw MobilePilotError.unavailable }
        let item = try SyntheticAccessRecord(pins: pins, credential: credential, clientID: clientID)
        do { try store.save(item) }
        catch { removalUnconfirmed = true; throw error }
    }

    public func restore() async throws -> ManagedOAuthCredential? {
        guard !working, !revoking, !removalUnconfirmed else { throw MobilePilotError.unavailable }
        guard let item = try store.load() else { return nil }
        guard item.resource == pins.resource, item.issuer == pins.issuer else { throw MobilePilotError.invalidResponse }
        let credential = ManagedOAuthCredential(accessToken: item.token, refreshToken: nil, expiresAt: item.expiresAt)
        // Reject corrupted, expired, excessively long-lived, or mismatched records.
        do { _ = try SyntheticAccessRecord(pins: pins, credential: credential, clientID: item.clientID) }
        catch {
            do { try store.clear() } catch { removalUnconfirmed = true }
            throw MobilePilotError.expired
        }
        working = true; let ticket = generation
        defer { working = false }
        do { try await verify(credential) }
        catch SyntheticProbeFailure.edgeUnauthorized {
            // A denial must not leave an automatically reusable token behind.
            if generation == ticket {
                do { try store.clear() } catch { removalUnconfirmed = true }
            }
            throw SyntheticProbeFailure.edgeUnauthorized
        }
        try Task.checkCancellation()
        guard generation == ticket, credential.expiresAt > Date() else { throw MobilePilotError.signedOut }
        return credential
    }

    /// No remote outcome is claimed: the original refresh token is deliberately
    /// not persisted and the provider grant may still be active after restart.
    public func signOut() async -> SyntheticAccessSignOut {
        guard !revoking else { return .remoteRevocationUnconfirmed }
        generation &+= 1
        let item: SyntheticAccessRecord?
        do { item = try store.load(); try store.clear(); removalUnconfirmed = false }
        catch ManagedOAuthStoreError.invalid {
            // An unreadable record can be deleted even though no token can be
            // extracted for provider revocation. Locked storage is distinct.
            do { try store.clear(); removalUnconfirmed = false; return .remoteRevocationUnconfirmed }
            catch { removalUnconfirmed = true; return .localRemovalUnconfirmed }
        }
        catch { removalUnconfirmed = true; return .localRemovalUnconfirmed }
        guard let item else { return .noLocalCredential }
        revoking = true; defer { revoking = false }
        try? await revoke(item.token, item.clientID)
        return .remoteRevocationUnconfirmed
    }
}

#if os(iOS) && canImport(Security)
/// Separate Keychain record; unavailable/locked storage is never treated as absent.
public struct SyntheticAccessKeychainStore: SyntheticAccessStore {
    public init() {}
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.ledgetoptechnologies.ops.pilot.synthetic-access.v1",
         kSecAttrAccount as String: SyntheticRefreshExperiment.resource,
         kSecAttrSynchronizable as String: false]
    }
    public func load() throws -> SyntheticAccessRecord? {
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ManagedOAuthStoreError.unavailable }
        guard let data = result as? Data, data.count <= 8192,
              let value = try? JSONDecoder().decode(SyntheticAccessRecord.self, from: data) else { throw ManagedOAuthStoreError.invalid }
        return value
    }
    public func save(_ value: SyntheticAccessRecord) throws {
        let data = try JSONEncoder().encode(value)
        var item = query; item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ManagedOAuthStoreError.unavailable }
    }
    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ManagedOAuthStoreError.unavailable }
    }
}
#endif
