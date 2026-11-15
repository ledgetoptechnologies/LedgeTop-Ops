import Foundation

// What the native workspace currently knows, and the rules for replacing it.
// Platform-independent so the ordering and authority rules are covered by
// package tests:
//  - a response is applied only if nothing newer was requested meanwhile;
//  - a client page and its cursor always belong to the query that produced them;
//  - "signed out" from any read clears everything and returns to sign-in;
//  - "forbidden" for one area clears that area only;
//  - a transient failure keeps the last good data and marks it as not current.

/// How current one area's data is.
public enum OpsWorkspaceFreshness: Equatable, Sendable {
    /// Nothing has been asked for yet.
    case idle
    /// The latest request succeeded.
    case current
    /// The latest request failed for a passing reason; any data shown is from an earlier load.
    case notRefreshed(OpsWorkspaceError)
    /// The server says this account may not read this area. No data is kept.
    case denied
}

@MainActor
public final class OpsWorkspaceStore {
    public enum State: Equatable, Sendable { case checking, signedOut, ready, forbidden, serverTrouble, unavailable }

    public private(set) var state: State = .checking
    public private(set) var user: OpsWorkspaceUser?
    public private(set) var dashboard: OpsWorkspaceDashboard?
    public private(set) var dashboardFreshness = OpsWorkspaceFreshness.idle
    public private(set) var operations: [OpsWorkspaceFieldOperation]?
    public private(set) var operationsFreshness = OpsWorkspaceFreshness.idle
    public private(set) var tasks: [OpsWorkspaceFieldTask]?
    public private(set) var tasksFreshness = OpsWorkspaceFreshness.idle
    public private(set) var clients: [OpsWorkspaceClient] = []
    public private(set) var clientsFreshness = OpsWorkspaceFreshness.idle
    /// The search text the shown clients and `nextCursor` belong to.
    public private(set) var clientsQuery = ""
    public private(set) var nextCursor: String?
    public private(set) var loadingClients = false
    /// Called after any change, for the UI layer to redraw.
    public var onChange: (() -> Void)?

    private let api: OpsWorkspaceAPI
    private let prepare: () async -> Void
    /// Bumped by refresh and sign-out: everything requested earlier is out of date.
    private var sessionGeneration = 0
    /// Bumped by every new client query: earlier client responses are out of date.
    private var queryGeneration = 0
    private var clientRequests = 0

    /// `prepare` runs before the first read of each refresh (the app uses it to load the saved session).
    public init(api: OpsWorkspaceAPI, prepare: @escaping () async -> Void = {}) {
        self.api = api
        self.prepare = prepare
    }

    /// Reloads everything. `search` is the client query to load alongside.
    public func refresh(search: String? = nil) async {
        sessionGeneration += 1
        queryGeneration += 1
        let session = sessionGeneration, query = queryGeneration
        let wanted = OpsWorkspaceStore.normalized(search ?? clientsQuery)
        if user == nil { state = .checking; changed() }
        await prepare()
        guard session == sessionGeneration else { return }
        do {
            let user = try await api.session()
            guard session == sessionGeneration else { return }
            self.user = user
            state = .ready
            changed()
        } catch {
            guard session == sessionGeneration else { return }
            sessionFailed(error)
            return
        }
        beginClientRequest()
        let api = self.api
        async let boardResult = OpsWorkspaceStore.result { try await api.dashboard() }
        async let operationsResult = OpsWorkspaceStore.result { try await api.operations() }
        async let tasksResult = OpsWorkspaceStore.result { try await api.tasks() }
        async let clientsResult = OpsWorkspaceStore.result { try await api.clients(search: wanted) }
        let board = await boardResult, operations = await operationsResult, tasks = await tasksResult, page = await clientsResult
        endClientRequest()
        guard session == sessionGeneration else { return }
        // Losing the session part-way through is still "signed out": nothing read before it may stay on screen.
        if [board.failure, operations.failure, tasks.failure, page.failure].contains(.signedOut) {
            signedOutByServer()
            return
        }
        apply(board, to: \.dashboard, freshness: \.dashboardFreshness)
        apply(operations, to: \.operations, freshness: \.operationsFreshness)
        apply(tasks, to: \.tasks, freshness: \.tasksFreshness)
        if query == queryGeneration { applyClients(page, query: wanted, appending: false) }
        changed()
    }

    /// Loads the first page for a new client search. Only the latest search's answer is ever shown.
    public func searchClients(_ text: String) async {
        guard state == .ready else { return }
        queryGeneration += 1
        let session = sessionGeneration, query = queryGeneration
        let wanted = OpsWorkspaceStore.normalized(text)
        beginClientRequest()
        let api = self.api
        let page = await OpsWorkspaceStore.result { try await api.clients(search: wanted) }
        endClientRequest()
        guard session == sessionGeneration, query == queryGeneration else { return }
        if page.failure == .signedOut { signedOutByServer(); return }
        applyClients(page, query: wanted, appending: false)
        changed()
    }

    /// Loads the next page of the clients currently shown, using the query that produced the cursor.
    public func loadMoreClients() async {
        guard state == .ready, let cursor = nextCursor, !loadingClients else { return }
        let session = sessionGeneration, query = queryGeneration, wanted = clientsQuery
        beginClientRequest()
        let api = self.api
        let page = await OpsWorkspaceStore.result { try await api.clients(search: wanted, cursor: cursor) }
        endClientRequest()
        // A new search started while this page was loading: the page belongs to the old list.
        guard session == sessionGeneration, query == queryGeneration else { return }
        if page.failure == .signedOut { signedOutByServer(); return }
        applyClients(page, query: wanted, appending: true)
        changed()
    }

    /// Ends the session locally. `clear` removes the stored sign-in; responses still in flight are ignored.
    public func signOut(clear: () async -> Void = {}) async {
        sessionGeneration += 1
        queryGeneration += 1
        clearData()
        state = .signedOut
        changed()
        await clear()
    }

    // MARK: Applying results

    private struct Outcome<Value: Sendable>: Sendable {
        let value: Value?
        let failure: OpsWorkspaceError?
    }

    private nonisolated static func result<Value: Sendable>(_ work: @Sendable () async throws -> Value) async -> Outcome<Value> {
        do { return Outcome(value: try await work(), failure: nil) }
        catch { return Outcome(value: nil, failure: (error as? OpsWorkspaceError) ?? .unavailable) }
    }

    private func apply<Value>(_ outcome: Outcome<Value>, to value: ReferenceWritableKeyPath<OpsWorkspaceStore, Value?>,
                              freshness: ReferenceWritableKeyPath<OpsWorkspaceStore, OpsWorkspaceFreshness>) {
        if let loaded = outcome.value {
            self[keyPath: value] = loaded
            self[keyPath: freshness] = .current
        } else if outcome.failure == .forbidden {
            self[keyPath: value] = nil
            self[keyPath: freshness] = .denied
        } else {
            // Keep the last good data, but say it was not refreshed.
            self[keyPath: freshness] = .notRefreshed(outcome.failure ?? .unavailable)
        }
    }

    private func applyClients(_ outcome: Outcome<OpsWorkspaceClientPage>, query: String, appending: Bool) {
        if let page = outcome.value {
            if appending {
                let known = Set(clients.map(\.id))
                clients += page.clients.filter { !known.contains($0.id) }
            } else {
                clients = page.clients
            }
            clientsQuery = query
            nextCursor = page.nextCursor
            clientsFreshness = .current
        } else if outcome.failure == .forbidden {
            clients = []
            nextCursor = nil
            clientsQuery = query
            clientsFreshness = .denied
        } else {
            // Rows from a different search must never appear under this one.
            if !appending, clientsQuery != query {
                clients = []
                nextCursor = nil
                clientsQuery = query
            }
            clientsFreshness = .notRefreshed(outcome.failure ?? .unavailable)
        }
    }

    private func sessionFailed(_ error: Error) {
        switch (error as? OpsWorkspaceError) ?? .unavailable {
        case .signedOut: clearData(); state = .signedOut
        case .forbidden: clearData(); state = .forbidden
        // With nobody signed in there is nothing to show; otherwise keep the last good data on screen.
        case .busy: if user == nil { state = .serverTrouble } else { markNotRefreshed(.busy) }
        case .unavailable: if user == nil { state = .unavailable } else { markNotRefreshed(.unavailable) }
        }
        changed()
    }

    private func markNotRefreshed(_ error: OpsWorkspaceError) {
        if dashboardFreshness != .denied { dashboardFreshness = .notRefreshed(error) }
        if operationsFreshness != .denied { operationsFreshness = .notRefreshed(error) }
        if tasksFreshness != .denied { tasksFreshness = .notRefreshed(error) }
        if clientsFreshness != .denied { clientsFreshness = .notRefreshed(error) }
    }

    private func signedOutByServer() {
        sessionGeneration += 1
        queryGeneration += 1
        clearData()
        state = .signedOut
        changed()
    }

    private func clearData() {
        user = nil
        dashboard = nil
        operations = nil
        tasks = nil
        clients = []
        nextCursor = nil
        clientsQuery = ""
        dashboardFreshness = .idle
        operationsFreshness = .idle
        tasksFreshness = .idle
        clientsFreshness = .idle
    }

    private func beginClientRequest() { clientRequests += 1; loadingClients = true; changed() }
    private func endClientRequest() { clientRequests -= 1; loadingClients = clientRequests > 0 }
    private func changed() { onChange?() }

    static func normalized(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}
