import Foundation

/// Native presentation backed exclusively by the narrow mobile facade. No web
/// cookie, arbitrary URL, mutable endpoint or website fallback is available.
/// The integrator owns Keychain/OAuth lifecycle and must invalidate the store
/// and this source on sign-out, expiry and account changes.
public actor ScopedPilotDataSource: OpsWorkspaceDataSource {
    public typealias CredentialSource = @Sendable () async -> ManagedOAuthCredential?
    public nonisolated let allowsWebFallback = false
    public nonisolated let searchesAllClients = false
    private let api: ManagedPilotDataAPI
    private let credentialSource: CredentialSource
    private var epoch = 0
    private var authorization: Authorization?
    /// Use this deadline to clear/lock displayed data without waiting for the
    /// next network request. Recheck online on foreground and after restoration.
    public var sessionExpiresAt: Date? { authorization?.expiresAt }
    public func sessionDeadline() async -> Date? { sessionExpiresAt }
    private struct Authorization: Sendable {
        let token: String
        let userID: String
        let expiresAt: Date
    }
    private struct Cursor: Codable {
        let query: String
        let user: String
        let after: String
    }

    public init(api: ManagedPilotDataAPI, credential: @escaping CredentialSource) {
        self.api = api
        self.credentialSource = credential
    }

    /// Clears authority and invalidates responses already in flight. This does
    /// not claim provider revocation or delete the integrator's Keychain record.
    public func invalidate() async { clearAuthorization() }

    private func clearAuthorization() {
        epoch += 1
        authorization = nil
    }

    public func session() async throws -> OpsWorkspaceUser {
        epoch += 1
        let ticket = epoch
        do {
            guard let credential = await credentialSource(), credential.expiresAt > Date() else {
                throw OpsWorkspaceError.signedOut
            }
            let session = try await api.identity(credential: credential)
            let bounded = try ManagedPilotDataAPI.credential(credential, boundedBy: session)
            guard session.user.id.utf8.count <= 512,
                  let current = await credentialSource(), current.accessToken == credential.accessToken,
                  current.expiresAt > Date(), bounded.expiresAt > Date(), ticket == epoch else {
                throw OpsWorkspaceError.signedOut
            }
            authorization = Authorization(token: credential.accessToken, userID: session.user.id,
                                           expiresAt: bounded.expiresAt)
            // The narrow contract does not disclose a staff role/profile type.
            return OpsWorkspaceUser(id: session.user.id, displayName: session.user.displayName,
                                    email: session.user.email, profileType: "")
        } catch {
            let failure = Self.classify(error, identity: true)
            if ticket == epoch, failure == .signedOut { clearAuthorization() }
            throw failure
        }
    }

    public func dashboard() async throws -> OpsWorkspaceDashboard { throw OpsWorkspaceError.notOffered }
    public func tasks() async throws -> [OpsWorkspaceFieldTask] { throw OpsWorkspaceError.notOffered }

    public func operations() async throws -> [OpsWorkspaceFieldOperation] {
        let api = self.api
        var collection = MobileOperationCollection()
        // The protocol currently returns a complete array. Fail explicitly
        // beyond this resource bound instead of silently dropping a cursor
        // and presenting a partial list as complete.
        for _ in 0..<20 {
            let cursor = collection.nextCursor
            let page = try await read { credential, _ in
                try await api.operations(credential: credential, cursor: cursor)
            }
            do { try collection.append(page, requestedCursor: cursor) }
            catch { throw Self.classify(error) }
            if collection.nextCursor == nil {
                return collection.operations.map {
                    OpsWorkspaceFieldOperation(id: $0.id, title: $0.title, status: $0.status,
                        scheduledStart: $0.scheduledStart, scheduledEnd: $0.scheduledEnd,
                        location: $0.location, notes: nil, project: $0.projectName, division: $0.divisionName)
                }
            }
        }
        throw OpsWorkspaceError.unavailable
    }

    /// Search filters this loaded page; the UI must use searchesAllClients=false
    /// and keep Load more visible even for an empty filtered page with a cursor.
    public func clients(search: String, cursor: String?) async throws -> OpsWorkspaceClientPage {
        let api = self.api
        return try await read { credential, user in
            guard api.businessReadsAvailable else { throw OpsWorkspaceError.notOffered }
            let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard query.utf8.count <= 512 else { throw OpsWorkspaceError.unavailable }
            let after = try Self.decode(cursor, query: query, user: user)
            let page = try await api.businessRoots(credential: credential, cursor: after)
            guard page.nextCursor == nil || page.nextCursor != after else { throw OpsWorkspaceError.unavailable }
            let clients = try page.roots.filter { query.isEmpty || $0.name.lowercased().contains(query) }.map { root in
                OpsWorkspaceClient(id: try Self.clientID(root), name: root.name, kind: root.kind,
                                   sourceName: root.sourceId, lastActivity: nil, detailPath: nil)
            }
            return OpsWorkspaceClientPage(clients: clients,
                nextCursor: try Self.encode(page.nextCursor, query: query, user: user))
        }
    }

    /// Root identity is decoded from the full tuple, never from a website path.
    /// The server still independently authorizes the source, root and projects.
    public func projects(client: OpsWorkspaceClient, cursor: String? = nil) async throws -> MobileBusinessProjectsPage {
        let api = self.api
        return try await read { credential, user in
            guard api.businessReadsAvailable else { throw OpsWorkspaceError.notOffered }
            let root = try Self.root(client)
            let query = "projects:" + client.id
            let after = try Self.decode(cursor, query: query, user: user)
            let page = try await api.businessProjects(credential: credential, root: root, cursor: after)
            guard page.nextCursor == nil || page.nextCursor != after else { throw OpsWorkspaceError.unavailable }
            return MobileBusinessProjectsPage(schemaVersion: page.schemaVersion, projects: page.projects,
                nextCursor: try Self.encode(page.nextCursor, query: query, user: user))
        }
    }

    public func projects(for client: OpsWorkspaceClient, cursor: String?) async throws -> OpsWorkspaceProjectPage {
        let page = try await projects(client: client, cursor: cursor)
        let projects = try page.projects.map {
            OpsWorkspaceProject(id: Self.base64(try JSONEncoder().encode([$0.origin, $0.idValue])), name: $0.name,
                                status: $0.status, startDate: $0.startDate, endDate: $0.endDate)
        }
        return OpsWorkspaceProjectPage(projects: projects, nextCursor: page.nextCursor)
    }

    private func read<T: Sendable>(_ work: @Sendable (ManagedOAuthCredential, String) async throws -> T) async throws -> T {
        let ticket = epoch
        do {
            guard let authorized = authorization, authorized.expiresAt > Date(),
                  let current = await credentialSource(), current.expiresAt > Date(),
                  current.accessToken == authorized.token, ticket == epoch else { throw OpsWorkspaceError.signedOut }
            let credential = ManagedOAuthCredential(accessToken: current.accessToken, refreshToken: nil,
                expiresAt: min(current.expiresAt, authorized.expiresAt))
            let result = try await work(credential, authorized.userID)
            guard ticket == epoch, authorization?.userID == authorized.userID,
                  credential.expiresAt > Date(), let latest = await credentialSource(),
                  latest.accessToken == authorized.token, latest.expiresAt > Date(), ticket == epoch else {
                throw OpsWorkspaceError.signedOut
            }
            return result
        } catch {
            if error is CancellationError { throw error }
            let failure = Self.classify(error)
            if ticket == epoch, failure == .signedOut { clearAuthorization() }
            throw failure
        }
    }

    private static func classify(_ error: Error, identity: Bool = false) -> OpsWorkspaceError {
        if let error = error as? OpsWorkspaceError { return error }
        switch error as? MobilePilotError {
        case .signedOut, .expired: return .signedOut
        case .denied: return identity ? .signedOut : .forbidden
        case .notFound: return identity ? .signedOut : .notOffered
        case .unavailable: return .busy
        default: return .unavailable
        }
    }

    private static func clientID(_ root: MobileBusinessRoot) throws -> String {
        guard root.isValid else { throw OpsWorkspaceError.unavailable }
        return base64(try JSONEncoder().encode([root.sourceId, root.rootNamespace, root.kind, root.clientHubRootId]))
    }
    private static func root(_ client: OpsWorkspaceClient) throws -> MobileBusinessRoot {
        guard client.id.utf8.count <= 4096,
              let parts = try? JSONDecoder().decode([String].self, from: unbase64(client.id)), parts.count == 4 else {
            throw OpsWorkspaceError.unavailable
        }
        let root = MobileBusinessRoot(sourceId: parts[0], rootNamespace: parts[1], kind: parts[2],
                                      clientHubRootId: parts[3], name: client.name)
        guard root.isValid, try clientID(root) == client.id else { throw OpsWorkspaceError.unavailable }
        return root
    }
    private static func encode(_ after: String?, query: String, user: String) throws -> String? {
        guard let after else { return nil }
        let value = base64(try JSONEncoder().encode(Cursor(query: query, user: user, after: after)))
        guard value.utf8.count <= 8192 else { throw OpsWorkspaceError.unavailable }
        return value
    }
    private static func decode(_ cursor: String?, query: String, user: String) throws -> String? {
        guard let cursor else { return nil }
        guard cursor.utf8.count <= 8192,
              let value = try? JSONDecoder().decode(Cursor.self, from: unbase64(cursor)),
              value.query == query, value.user == user,
              MobilePilotConfiguration.isBase64URL(value.after, range: 1...4096) else {
            throw OpsWorkspaceError.unavailable
        }
        return value.after
    }
    private static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func unbase64(_ value: String) throws -> Data {
        guard MobilePilotConfiguration.isBase64URL(value, range: 1...8192),
              let data = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)) else {
            throw OpsWorkspaceError.unavailable
        }
        return data
    }
}
