import Foundation

/// Where the native workspace gets its data. The store and the screens depend only on this,
/// so a scoped read-only source can replace the staff web session without touching them.
///
/// Rules for every implementation:
///  - throw `OpsWorkspaceError.signedOut` when the credential is missing, expired or revoked;
///  - throw `.forbidden` when this account may not read the area;
///  - throw `.notOffered` for an area this source does not provide (never substitute another source);
///  - throw `.busy` for a server error and `.unavailable` for anything else.
public protocol OpsWorkspaceDataSource: Sendable {
    /// False for a read-only source: the app then hides every route into the full website.
    var allowsWebFallback: Bool { get }
    /// True when `clients(search:)` searches every client on the server. False when the source can only
    /// narrow the pages it has loaded; the app then words the search as a filter, never as a full search.
    var searchesAllClients: Bool { get }
    func session() async throws -> OpsWorkspaceUser
    func dashboard() async throws -> OpsWorkspaceDashboard
    func operations() async throws -> [OpsWorkspaceFieldOperation]
    func tasks() async throws -> [OpsWorkspaceFieldTask]
    func clients(search: String, cursor: String?) async throws -> OpsWorkspaceClientPage
    /// One page of a client's projects. Sources without this throw `.notOffered` (the default).
    func projects(for client: OpsWorkspaceClient, cursor: String?) async throws -> OpsWorkspaceProjectPage
    /// When the current sign-in stops being valid, if the source knows. The app re-checks at that moment.
    func sessionDeadline() async -> Date?
    /// Drops any credential or cached state the source holds. Called on sign-out and on loss of authority.
    func invalidate() async
}

/// A project belonging to one client.
public struct OpsWorkspaceProject: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let status: String?
    public let startDate: String?
    public let endDate: String?
    public init(id: String, name: String, status: String? = nil, startDate: String? = nil, endDate: String? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.startDate = startDate
        self.endDate = endDate
    }
}

public struct OpsWorkspaceProjectPage: Equatable, Sendable {
    public let projects: [OpsWorkspaceProject]
    public let nextCursor: String?
    public init(projects: [OpsWorkspaceProject], nextCursor: String?) {
        self.projects = projects
        self.nextCursor = nextCursor
    }
}

public extension OpsWorkspaceDataSource {
    var searchesAllClients: Bool { true }
    func projects(for client: OpsWorkspaceClient, cursor: String?) async throws -> OpsWorkspaceProjectPage {
        throw OpsWorkspaceError.notOffered
    }
    func sessionDeadline() async -> Date? { nil }
    func invalidate() async {}
}

/// The ordinary staff web session: the person's full authority, with the website as a fallback.
extension OpsWorkspaceAPI: OpsWorkspaceDataSource {
    public var allowsWebFallback: Bool { true }
}
