import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Native data access to the Ops workspace: the same JSON the website reads,
// fetched by native code with the session the person signed in with. Native
// screens are built on this; the embedded web view is only the fallback for
// screens that are not native yet.

public enum OpsWorkspaceError: Error, Equatable, Sendable {
    /// No session, or the server asked for sign-in again.
    case signedOut
    /// Signed in, but this account may not read the resource.
    case forbidden
    /// The server says this resource is temporarily not ready (HTTP 503).
    case busy
    /// Network trouble or a response the app does not understand.
    case unavailable
}

public struct OpsWorkspaceUser: Equatable, Sendable {
    public let displayName: String
    public let email: String
    public let profileType: String
}

public struct OpsWorkspaceOperation: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let status: String
    public let scheduledStart: String?
    public let division: String?
}

/// One field operation from the full operations list.
public struct OpsWorkspaceFieldOperation: Equatable, Sendable, Identifiable, Hashable {
    public let id: String
    public let title: String
    public let status: String
    public let scheduledStart: String?
    public let scheduledEnd: String?
    public let location: String?
    public let notes: String?
    public let project: String?
    public let division: String?

    public var isOpen: Bool { status != "completed" && status != "cancelled" }
    public var statusLabel: String {
        status.isEmpty ? "Unknown" : status.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// Case-insensitive match on title, project, location or division. An empty query matches everything.
    public func matches(_ query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return true }
        return [title, project, location, division].compactMap { $0?.lowercased() }.contains { $0.contains(needle) }
    }
}

public enum OpsWorkspaceOperationFilter: String, CaseIterable, Sendable {
    case open, all, completed
    public var label: String {
        switch self {
        case .open: return "Open"
        case .all: return "All"
        case .completed: return "Completed"
        }
    }
    public func includes(_ operation: OpsWorkspaceFieldOperation) -> Bool {
        switch self {
        case .open: return operation.isOpen
        case .all: return true
        case .completed: return operation.status == "completed"
        }
    }
}

public extension Array where Element == OpsWorkspaceFieldOperation {
    func filtered(_ filter: OpsWorkspaceOperationFilter, search: String) -> [OpsWorkspaceFieldOperation] {
        self.filter { filter.includes($0) && $0.matches(search) }
    }
}

public struct OpsWorkspaceTask: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let status: String
    public let dueAt: String?
}

public struct OpsWorkspaceDashboard: Equatable, Sendable {
    public let operations: [OpsWorkspaceOperation]
    public let tasks: [OpsWorkspaceTask]
    public let activeTfrs: Int
    public let scheduledTfrs: Int
    /// True when the server reports its project data may be out of date.
    public let dataMayBeStale: Bool
}

public struct OpsWorkspaceClient: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let kind: String
    public let sourceName: String?
    public let lastActivity: String?
    /// Website path for this client's full page, when the server supplied a safe one.
    public let detailPath: String?
    public var kindLabel: String { kind == "organization" ? "Organization" : "Client" }
}

public struct OpsWorkspaceClientPage: Equatable, Sendable {
    public let clients: [OpsWorkspaceClient]
    public let nextCursor: String?
}

public struct OpsWorkspaceAPI: Sendable {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    public typealias CookieSource = @Sendable () async -> String?

    public typealias Observer = @Sendable (_ path: String, _ status: Int) -> Void

    public let origin: WebShellOrigin
    private let cookies: CookieSource
    private let transport: Transport
    private let observer: Observer?

    /// `observer` receives each request's path and HTTP status (0 when no response arrived), for diagnostics.
    public init(origin: WebShellOrigin, cookies: @escaping CookieSource,
                transport: @escaping Transport = OpsWorkspaceAPI.networkTransport(), observer: Observer? = nil) {
        self.origin = origin
        self.cookies = cookies
        self.transport = transport
        self.observer = observer
    }

    public func session() async throws -> OpsWorkspaceUser {
        let root = try await object("/api/session")
        guard let user = root["user"] as? [String: Any], let email = text(user["email"]) else { throw OpsWorkspaceError.unavailable }
        return OpsWorkspaceUser(displayName: text(user["displayName"]) ?? email, email: email,
                                profileType: text(user["profileType"]) ?? "Employee")
    }

    public func dashboard() async throws -> OpsWorkspaceDashboard {
        let root = try await object("/api/dashboard")
        let operations = rows(root["operations"]).compactMap { row -> OpsWorkspaceOperation? in
            guard let id = text(row["id"]), let title = text(row["title"]) else { return nil }
            return OpsWorkspaceOperation(id: id, title: title, status: text(row["status"]) ?? "",
                                         scheduledStart: text(row["scheduled_start"]), division: text(row["division_name"]))
        }
        let tasks = rows(root["tasks"]).compactMap { row -> OpsWorkspaceTask? in
            guard let id = text(row["id"]), let title = text(row["title"]) else { return nil }
            return OpsWorkspaceTask(id: id, title: title, status: text(row["status"]) ?? "", dueAt: text(row["due_at"]))
        }
        let airspace = root["airspace"] as? [String: Any] ?? [:]
        let stale = rows(root["integrations"]).contains { ($0["stale"] as? Bool) == true }
        return OpsWorkspaceDashboard(operations: operations, tasks: tasks,
                                     activeTfrs: (airspace["activeTfrs"] as? Int) ?? 0,
                                     scheduledTfrs: (airspace["scheduledTfrs"] as? Int) ?? 0, dataMayBeStale: stale)
    }

    /// The operations this account may see, newest first, as the server orders them.
    public func operations() async throws -> [OpsWorkspaceFieldOperation] {
        let root = try await object("/api/operations")
        return rows(root["operations"]).compactMap { row in
            guard let id = text(row["id"]), let title = text(row["title"]) else { return nil }
            return OpsWorkspaceFieldOperation(id: id, title: title, status: text(row["status"]) ?? "",
                                              scheduledStart: text(row["scheduled_start"]), scheduledEnd: text(row["scheduled_end"]),
                                              location: text(row["location"]), notes: text(row["notes"]),
                                              project: text(row["project_name"]), division: text(row["division_name"]))
        }
    }

    public func clients(search: String = "", cursor: String? = nil) async throws -> OpsWorkspaceClientPage {
        var query = [URLQueryItem(name: "limit", value: "50")]
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { query.append(URLQueryItem(name: "q", value: String(trimmed.prefix(200)))) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        let root = try await object("/api/client-hub", query: query)
        let clients = rows(root["clients"]).compactMap { row -> OpsWorkspaceClient? in
            guard let source = text(row["source_id"]), let kind = text(row["kind"]),
                  let publicId = text(row["public_id"]), let name = text(row["display_name"]) else { return nil }
            let namespace = text(row["root_namespace"]) ?? ""
            return OpsWorkspaceClient(id: [source, namespace, kind, publicId].joined(separator: "|"), name: name, kind: kind,
                                      sourceName: text(row["source_name"]), lastActivity: text(row["meaningful_activity_at"]),
                                      detailPath: text(row["detail_path"]).flatMap(OpsWorkspaceAPI.safePath))
        }
        let next = text(root["nextCursor"]).flatMap { $0.utf8.count <= 4096 ? $0 : nil }
        return OpsWorkspaceClientPage(clients: clients, nextCursor: next)
    }

    /// A server-supplied website path is used only when it is a plain same-site path.
    static func safePath(_ path: String) -> String? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), path.utf8.count <= 512, !path.contains("\\"),
              !path.contains("?"), !path.contains("#"), !path.contains(".."),
              !path.unicodeScalars.contains(where: { $0.value <= 32 || $0.value >= 127 }) else { return nil }
        return path
    }

    // MARK: Transport

    private func object(_ path: String, query: [URLQueryItem] = []) async throws -> [String: Any] {
        guard let cookie = await cookies(), !cookie.isEmpty else { throw OpsWorkspaceError.signedOut }
        var parts = URLComponents(url: origin.url, resolvingAgainstBaseURL: false)!
        parts.path = path
        if !query.isEmpty { parts.queryItems = query }
        guard let url = parts.url, WebShellOrigin(url: url) == origin else { throw OpsWorkspaceError.unavailable }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.httpShouldHandleCookies = false
        let data: Data, response: HTTPURLResponse
        do { (data, response) = try await transport(request) } catch {
            observer?(path, 0)
            throw OpsWorkspaceError.unavailable
        }
        observer?(path, response.statusCode)
        // Cloudflare Access answers an expired session with a redirect to its sign-in page.
        if response.statusCode == 401 || (300...399).contains(response.statusCode) { throw OpsWorkspaceError.signedOut }
        if response.statusCode == 403 { throw OpsWorkspaceError.forbidden }
        if response.statusCode == 503 { throw OpsWorkspaceError.busy }
        let type = response.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        guard response.statusCode == 200, response.url.flatMap(WebShellOrigin.init(url:)) == origin else { throw OpsWorkspaceError.unavailable }
        // A sign-in page served with 200 is still "signed out", never data.
        guard type.hasPrefix("application/json") else { throw OpsWorkspaceError.signedOut }
        guard data.count <= 4_000_000, let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw OpsWorkspaceError.unavailable
        }
        return root
    }

    private func rows(_ value: Any?) -> [[String: Any]] { (value as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }

    /// Server ids arrive as strings or whole numbers; other types are ignored.
    private func text(_ value: Any?) -> String? {
        if let string = value as? String { return string.isEmpty || string.utf8.count > 2048 ? nil : string }
        if value is Bool { return nil }
        if let number = value as? Int { return String(number) }
        return nil
    }

    /// Ephemeral session: no stored cookies, no cache, and redirects are returned rather than followed.
    public static func networkTransport() -> Transport {
        let options = URLSessionConfiguration.ephemeral
        options.httpCookieStorage = nil
        options.httpShouldSetCookies = false
        options.urlCache = nil
        options.requestCachePolicy = .reloadIgnoringLocalCacheData
        options.timeoutIntervalForRequest = 30
        options.timeoutIntervalForResource = 45
        let session = URLSession(configuration: options, delegate: OpsWorkspaceNoRedirects(), delegateQueue: nil)
        return { request in
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw OpsWorkspaceError.unavailable }
            return (data, http)
        }
    }
}

private final class OpsWorkspaceNoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
