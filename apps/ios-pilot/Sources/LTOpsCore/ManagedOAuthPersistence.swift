import Foundation

/// Experimental restore state machine. It is deliberately not wired into the
/// app until the provider's public-client refresh and revocation semantics are
/// established and reviewed. The caller must verify the resulting credential
/// against its real server-side staff and record permissions before showing data.
public actor ManagedOAuthPersistence {
    private let pins: ManagedOAuthPins
    private let transport: any ManagedOAuthExchanging
    private let store: any ManagedOAuthGrantStore
    private var generation: UInt64 = 0
    private var refreshing = false
    private var revoking = false
    // A failed deletion can leave a grant on disk. Do not restore or replace
    // it in this process until a subsequent sign-out confirms local removal.
    private var localRemovalUnconfirmed = false
    private var grant: ManagedOAuthStoredGrant?
    private var access: ManagedOAuthCredential?
    private var uncertain = false

    public init(pins: ManagedOAuthPins, transport: any ManagedOAuthExchanging, store: any ManagedOAuthGrantStore) {
        self.pins = pins; self.transport = transport; self.store = store
    }

    /// Called only after successful interactive sign-in; the store is a single
    /// scoped item so a refresh-token replacement does not leave two versions.
    public func retain(credential: ManagedOAuthCredential, clientID: String) throws {
        guard !refreshing, !revoking, !localRemovalUnconfirmed, access == nil, grant == nil, credential.expiresAt > Date(), let refresh = credential.refreshToken else {
            throw MobilePilotError.invalidResponse
        }
        // Never overwrite an older grant whose revocation has not been attempted.
        guard try store.load() == nil else { throw MobilePilotError.unavailable }
        let next = try ManagedOAuthStoredGrant(pins: pins, clientID: clientID, refreshToken: refresh)
        do { try store.save(next) }
        catch {
            // A failed write may still have changed Keychain state. Require
            // explicit local cleanup before this process can restore a grant.
            localRemovalUnconfirmed = true; uncertain = true
            throw error
        }
        grant = next; access = credential
    }

    /// Always renew on restore, including after process/device restart. No
    /// cached business data or stale access token is trusted on startup.
    public func restore() async throws -> ManagedOAuthCredential? {
        guard !refreshing, !revoking, !localRemovalUnconfirmed else { throw MobilePilotError.unavailable }
        let saved: ManagedOAuthStoredGrant
        if let grant { saved = grant }
        else if let loaded = try store.load() { saved = loaded }
        else { return nil }
        try saved.validate(pins: pins)
        grant = saved
        refreshing = true
        let ticket = generation
        defer { refreshing = false }
        do {
            try await transport.verifyMetadata()
            try Task.checkCancellation()
            guard ticket == generation else { throw MobilePilotError.signedOut }
        } catch {
            // Metadata/network errors have not consumed the token; retain it.
            throw error
        }
        // Clear the old grant before dispatch. If the process dies during the
        // refresh, a restart cannot unknowingly replay a rotated token. A
        // failed deletion prevents the request from being sent at all.
        try store.clear()
        let received: ManagedOAuthCredential
        do {
            received = try await transport.refresh(token: saved.refreshToken, clientID: saved.clientID)
        } catch {
            // The server may have rotated a token before a response was lost.
            // Never blindly retry that potentially consumed grant.
            uncertain = true
            if ticket == generation {
                grant = nil; access = nil
                do { try store.clear() }
                catch { localRemovalUnconfirmed = true; throw error }
            }
            throw error
        }
        do {
            try Task.checkCancellation()
            guard ticket == generation else { throw MobilePilotError.signedOut }
            guard received.expiresAt > Date(), let nextToken = received.refreshToken else { throw MobilePilotError.invalidResponse }
            let next = try ManagedOAuthStoredGrant(pins: pins, clientID: saved.clientID, refreshToken: nextToken)
            try store.save(next)
            grant = next; access = received
            return ManagedOAuthCredential(accessToken: received.accessToken, refreshToken: nil, expiresAt: received.expiresAt)
        } catch {
            uncertain = true
            if ticket == generation {
                grant = nil; access = nil
                do { try store.clear() } catch { localRemovalUnconfirmed = true }
            }
            // A returned token cannot be retained after cancellation, sign-out,
            // failed validation, or a Keychain failure. Best-effort revocation.
            let transport = self.transport
            await Task.detached {
                if let token = received.refreshToken { try? await transport.revoke(token: token, clientID: saved.clientID, hint: .refresh) }
                try? await transport.revoke(token: received.accessToken, clientID: saved.clientID, hint: .access)
            }.value
            throw error
        }
    }

    /// Local deletion is synchronous and precedes network revocation. A Keychain
    /// error is surfaced separately; do not claim local sign-out in that case.
    public func signOut() async -> PersistentSignOutResult {
        guard !revoking else { return .revocationUnconfirmed }
        generation &+= 1
        let wasRefreshing = refreshing
        let oldAccess = access
        access = nil
        let old: ManagedOAuthStoredGrant?
        do { old = try grant ?? store.load(); try store.clear(); grant = nil; localRemovalUnconfirmed = false }
        catch { grant = nil; uncertain = true; localRemovalUnconfirmed = true; return .localRemovalUnconfirmed }
        guard let old else { return uncertain || wasRefreshing ? .revocationUnconfirmed : .noLocalCredential }
        revoking = true
        defer { revoking = false }
        var failed = false
        do { try await transport.revoke(token: old.refreshToken, clientID: old.clientID, hint: .refresh) } catch { failed = true }
        if let oldAccess {
            do { try await transport.revoke(token: oldAccess.accessToken, clientID: old.clientID, hint: .access) } catch { failed = true }
        }
        if failed || wasRefreshing { uncertain = true }
        return failed || uncertain ? .revocationUnconfirmed : .providerAcknowledged
    }
}

public enum PersistentSignOutResult: Sendable, Equatable {
    case noLocalCredential, providerAcknowledged, revocationUnconfirmed, localRemovalUnconfirmed
}
