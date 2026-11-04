import Foundation
#if canImport(Security)
import Security
#endif

/// An unactivated persistence candidate. No access token or operation data is stored.
/// All values are scoped to the reviewed resource and issuer pins.
public struct ManagedOAuthStoredGrant: Codable, Sendable, Equatable {
    public let resource: String
    public let issuer: String
    public let clientID: String
    public let refreshToken: String

    public init(pins: ManagedOAuthPins, clientID: String, refreshToken: String) throws {
        _ = try ManagedOAuthWire.refreshBody(refreshToken: refreshToken, clientID: clientID)
        resource = pins.resource; issuer = pins.issuer
        self.clientID = clientID; self.refreshToken = refreshToken
    }

    public func validate(pins: ManagedOAuthPins) throws {
        guard resource == pins.resource, issuer == pins.issuer else { throw MobilePilotError.invalidResponse }
        _ = try ManagedOAuthWire.refreshBody(refreshToken: refreshToken, clientID: clientID)
    }
}

public protocol ManagedOAuthGrantStore: Sendable {
    func load() throws -> ManagedOAuthStoredGrant?
    func save(_ value: ManagedOAuthStoredGrant) throws
    func clear() throws
}

public enum ManagedOAuthStoreError: Error, Sendable { case unavailable, invalid }

#if os(iOS) && canImport(Security)
/// Device-only, foreground-only Keychain record; a locked Keychain is reported,
/// never treated as an absent grant. This store is not wired into the app yet.
public struct ManagedOAuthKeychainStore: ManagedOAuthGrantStore {
    private let pins: ManagedOAuthPins
    public init(pins: ManagedOAuthPins) { self.pins = pins }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.ledgetoptechnologies.ops.pilot.oauth-refresh.v1",
         kSecAttrAccount as String: pins.resource,
         kSecAttrSynchronizable as String: false]
    }
    public func load() throws -> ManagedOAuthStoredGrant? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ManagedOAuthStoreError.unavailable }
        guard let data = result as? Data, data.count <= 8192,
              let value = try? JSONDecoder().decode(ManagedOAuthStoredGrant.self, from: data) else { throw ManagedOAuthStoreError.invalid }
        try value.validate(pins: pins)
        return value
    }
    public func save(_ value: ManagedOAuthStoredGrant) throws {
        try value.validate(pins: pins)
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
