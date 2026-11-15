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
    func session() async throws -> OpsWorkspaceUser
    func dashboard() async throws -> OpsWorkspaceDashboard
    func operations() async throws -> [OpsWorkspaceFieldOperation]
    func tasks() async throws -> [OpsWorkspaceFieldTask]
    func clients(search: String, cursor: String?) async throws -> OpsWorkspaceClientPage
}

/// The ordinary staff web session: the person's full authority, with the website as a fallback.
extension OpsWorkspaceAPI: OpsWorkspaceDataSource {
    public var allowsWebFallback: Bool { true }
}
