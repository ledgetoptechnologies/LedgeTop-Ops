import Foundation
#if canImport(Security)
import Security
#endif

/// A device-only restart record for the read-only pilot. It deliberately stores
/// only a short-lived access token: no refresh token, user profile, or business data.
public struct ManagedAccessOnlyRecord: Codable, Sendable, Equatable {
    public let resource: String
    public let issuer: String
    public let accessToken: String
    public let clientID: String
    public let expiresAt: Date

    public init(pins: ManagedOAuthPins, credential: ManagedOAuthCredential, clientID: String,
                session: MobilePilotSession, now: Date = Date()) throws {
        guard credential.refreshToken == nil, session.schemaVersion == 1, session.readOnly,
              !session.user.id.isEmpty, session.expiresAt > Int(now.timeIntervalSince1970),
              session.expiresAt <= Int(credential.expiresAt.timeIntervalSince1970) else {
            throw MobilePilotError.invalidResponse
        }
        let expiry = min(credential.expiresAt, Date(timeIntervalSince1970: TimeInterval(session.expiresAt)))
        guard expiry > now, expiry.timeIntervalSince(now) <= 900,
              Self.validOpaque(credential.accessToken, minimum: 7, maximum: 4096),
              Self.validClientID(clientID) else { throw MobilePilotError.invalidResponse }
        resource = pins.resource; issuer = pins.issuer
        accessToken = credential.accessToken; self.clientID = clientID; expiresAt = expiry
    }

    public func credential(pins: ManagedOAuthPins, now: Date = Date()) throws -> ManagedOAuthCredential {
        guard resource == pins.resource, issuer == pins.issuer,
              expiresAt > now, expiresAt.timeIntervalSince(now) <= 900,
              Self.validOpaque(accessToken, minimum: 7, maximum: 4096),
              Self.validClientID(clientID) else { throw MobilePilotError.expired }
        return ManagedOAuthCredential(accessToken: accessToken, refreshToken: nil, expiresAt: expiresAt)
    }

    private static func validOpaque(_ value: String, minimum: Int, maximum: Int) -> Bool {
        (minimum...maximum).contains(value.utf8.count) && value.utf8.allSatisfy { (33...126).contains($0) }
    }
    private static func validClientID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 512 && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 95, 46, 126].contains($0)
        }
    }
}

public protocol ManagedAccessOnlyStore: Sendable {
    func load() throws -> ManagedAccessOnlyRecord?
    func save(_ value: ManagedAccessOnlyRecord) throws
    func clear() throws
}

public struct ManagedAccessOnlyRestored: Sendable {
    public let credential: ManagedOAuthCredential
    public let clientID: String
    public let session: MobilePilotSession
}

public actor ManagedAccessOnlyRestore {
    private let pins: ManagedOAuthPins
    private let store: any ManagedAccessOnlyStore
    private let verify: @Sendable (ManagedOAuthCredential) async throws -> MobilePilotSession
    private var generation: UInt64 = 0
    private var working = false
    private var removalUnconfirmed = false

    public init(pins: ManagedOAuthPins, store: any ManagedAccessOnlyStore,
                verify: @escaping @Sendable (ManagedOAuthCredential) async throws -> MobilePilotSession) {
        self.pins = pins; self.store = store; self.verify = verify
    }

    /// Store only after the caller has verified the server session and bounded
    /// the credential to that session's expiry.
    public func retain(_ credential: ManagedOAuthCredential, clientID: String,
                       session: MobilePilotSession) throws {
        guard !working, !removalUnconfirmed else { throw MobilePilotError.unavailable }
        let value = try ManagedAccessOnlyRecord(pins: pins, credential: credential, clientID: clientID, session: session)
        do { try store.save(value) }
        catch {
            do { try store.clear() } catch { removalUnconfirmed = true }
            throw ManagedOAuthStoreError.unavailable
        }
    }

    /// A restored token is returned only after a fresh online identity check.
    /// Network errors retain the item for a later retry; authorization/session
    /// failures remove it before the caller can display any Operations data.
    public func restore() async throws -> ManagedAccessOnlyRestored? {
        guard !working, !removalUnconfirmed else { throw ManagedOAuthStoreError.unavailable }
        let item: ManagedAccessOnlyRecord?
        do { item = try store.load() }
        catch {
            if error is ManagedOAuthStoreError, case ManagedOAuthStoreError.invalid = error {
                do { try store.clear() } catch { removalUnconfirmed = true }
            }
            throw error
        }
        guard let item else { return nil }
        let credential: ManagedOAuthCredential
        do { credential = try item.credential(pins: pins) }
        catch {
            do { try store.clear() } catch { removalUnconfirmed = true }
            throw error
        }
        working = true
        let ticket = generation
        defer { working = false }
        do {
            let session = try await verify(credential)
            guard generation == ticket else { throw MobilePilotError.signedOut }
            guard session.schemaVersion == 1, session.readOnly, !session.user.id.isEmpty,
                  session.expiresAt > Int(Date().timeIntervalSince1970) else {
                throw MobilePilotError.invalidResponse
            }
            let bounded = try ManagedPilotDataAPI.credential(credential, boundedBy: session)
            return ManagedAccessOnlyRestored(credential: bounded, clientID: item.clientID, session: session)
        } catch {
            if generation == ticket, Self.mustClear(error) {
                do { try store.clear() } catch { removalUnconfirmed = true }
            }
            throw error
        }
    }

    /// Invalidate an in-flight restore before deleting the device-only record.
    @discardableResult public func signOut() -> Bool {
        generation &+= 1
        do { try store.clear(); removalUnconfirmed = false; return true }
        catch { removalUnconfirmed = true; return false }
    }

    private static func mustClear(_ error: Error) -> Bool {
        guard let error = error as? MobilePilotError else { return false }
        switch error {
        case .signedOut, .denied, .notFound, .expired, .invalidResponse: return true
        case .unavailable, .invalidCallback: return false
        }
    }
}

#if os(iOS) && canImport(Security)
/// Non-synchronizing Keychain storage available only while the device is unlocked.
public struct ManagedAccessOnlyKeychainStore: ManagedAccessOnlyStore {
    private let pins: ManagedOAuthPins
    public init(pins: ManagedOAuthPins) { self.pins = pins }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.ledgetoptechnologies.ops.pilot.readonly-access.v1",
         kSecAttrAccount as String: pins.resource,
         kSecAttrSynchronizable as String: false]
    }
    public func load() throws -> ManagedAccessOnlyRecord? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 8192,
              let value = try? JSONDecoder().decode(ManagedAccessOnlyRecord.self, from: data) else {
            throw ManagedOAuthStoreError.unavailable
        }
        return value
    }
    public func save(_ value: ManagedAccessOnlyRecord) throws {
        _ = try value.credential(pins: pins)
        let data = try JSONEncoder().encode(value)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw ManagedOAuthStoreError.unavailable }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ManagedOAuthStoreError.unavailable }
    }
    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ManagedOAuthStoreError.unavailable }
    }
}
#endif
