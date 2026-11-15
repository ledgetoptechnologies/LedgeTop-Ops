import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LTOpsCore

/// A fake server whose answers the test releases one at a time, in any order.
private actor HeldServer {
    struct Reply: Sendable { let status: Int; let body: String; let type: String }
    private var waiting: [String: [CheckedContinuation<Reply, Never>]] = [:]
    private var ready: [String: [Reply]] = [:]
    private(set) var seen: [String] = []

    /// Key is the path plus the `q` and `cursor` values, e.g. "/api/client-hub q=a cursor=c1".
    static func key(_ url: URL) -> String {
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var key = url.path
        for name in ["q", "cursor"] {
            if let value = parts?.queryItems?.first(where: { $0.name == name })?.value { key += " \(name)=\(value)" }
        }
        return key
    }

    func answer(_ key: String) async -> Reply {
        seen.append(key)
        if var queued = ready[key], !queued.isEmpty {
            let reply = queued.removeFirst()
            ready[key] = queued
            return reply
        }
        return await withCheckedContinuation { waiting[key, default: []].append($0) }
    }

    /// Answers a request now if one is waiting, otherwise the next one that arrives.
    func release(_ key: String, status: Int = 200, body: String, type: String = "application/json") {
        let reply = Reply(status: status, body: body, type: type)
        if var held = waiting[key], !held.isEmpty {
            held.removeFirst().resume(returning: reply)
            waiting[key] = held
        } else {
            ready[key, default: []].append(reply)
        }
    }

    func isWaiting(_ key: String) -> Bool { !(waiting[key] ?? []).isEmpty }
    func count(_ key: String) -> Int { seen.filter { $0 == key }.count }
}

@MainActor
final class OpsWorkspaceStoreTests: XCTestCase {
    private let origin = WebShellOrigin(configured: "https://ops.example.com")!
    private let sessionBody = #"{"user":{"email":"pat@example.com","displayName":"Pat","profileType":"Employee"}}"#

    private func makeStore(_ server: HeldServer) -> OpsWorkspaceStore {
        let api = OpsWorkspaceAPI(origin: origin, cookies: { "CF_Authorization=abc" }, transport: { request in
            let reply = await server.answer(HeldServer.key(request.url!))
            return (Data(reply.body.utf8), HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil,
                                                           headerFields: ["Content-Type": reply.type])!)
        })
        return OpsWorkspaceStore(api: api)
    }

    private func clients(_ names: [String], next: String? = nil) -> String {
        let rows = names.map { #"{"source_id":"s","root_namespace":"business","kind":"organization","public_id":"\#($0)","display_name":"\#($0)"}"# }
        return #"{"clients":[\#(rows.joined(separator: ","))],"nextCursor":\#(next.map { "\"\($0)\"" } ?? "null")}"#
    }

    /// Queues ordinary answers for a full refresh.
    private func allowRefresh(_ server: HeldServer, clientKey: String = "/api/client-hub", clientNames: [String] = ["Acme"], next: String? = nil) async {
        await server.release("/api/session", body: sessionBody)
        await server.release("/api/dashboard", body: #"{"operations":[{"id":"op1","title":"Survey"}],"tasks":[]}"#)
        await server.release("/api/operations", body: #"{"operations":[{"id":"op1","title":"Survey","status":"scheduled"}]}"#)
        await server.release("/api/tasks", body: #"{"tasks":[{"id":"t1","title":"Charge","status":"todo"}]}"#)
        await server.release(clientKey, body: clients(clientNames, next: next))
    }

    private func waitUntil(_ what: String, _ condition: @escaping () async -> Bool) async {
        for _ in 0..<2000 {
            if await condition() { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    func testRefreshLoadsEverythingAndReportsChanges() async {
        let server = HeldServer()
        let store = makeStore(server)
        var changes = 0
        store.onChange = { changes += 1 }
        await allowRefresh(server, next: "c1")
        await store.refresh()
        XCTAssertEqual(store.state, .ready)
        XCTAssertEqual(store.user?.displayName, "Pat")
        XCTAssertEqual(store.dashboard?.operations.count, 1)
        XCTAssertEqual(store.operations?.count, 1)
        XCTAssertEqual(store.tasks?.count, 1)
        XCTAssertEqual(store.clients.map(\.name), ["Acme"])
        XCTAssertEqual(store.nextCursor, "c1")
        XCTAssertEqual([store.dashboardFreshness, store.operationsFreshness, store.tasksFreshness, store.clientsFreshness],
                       [.current, .current, .current, .current])
        XCTAssertFalse(store.loadingClients)
        XCTAssertGreaterThan(changes, 0)
    }

    func testOlderSearchAnswerArrivingLastDoesNotReplaceNewerSearch() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server)
        await store.refresh()

        let first = Task { await store.searchClients("alpha") }
        await waitUntil("alpha request") { await server.isWaiting("/api/client-hub q=alpha") }
        let second = Task { await store.searchClients("beta") }
        await waitUntil("beta request") { await server.isWaiting("/api/client-hub q=beta") }
        XCTAssertTrue(store.loadingClients)

        // The newer search answers first; the older one answers afterwards with a cursor of its own.
        await server.release("/api/client-hub q=beta", body: clients(["Beta Co"], next: "beta-2"))
        await second.value
        await server.release("/api/client-hub q=alpha", body: clients(["Alpha Co"], next: "alpha-2"))
        await first.value

        XCTAssertEqual(store.clients.map(\.name), ["Beta Co"])
        XCTAssertEqual(store.clientsQuery, "beta")
        XCTAssertEqual(store.nextCursor, "beta-2")
        XCTAssertFalse(store.loadingClients)
    }

    func testClearingTheSearchWhileOneIsPendingShowsTheFullList() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server)
        await store.refresh()

        let typed = Task { await store.searchClients("alpha") }
        await waitUntil("alpha request") { await server.isWaiting("/api/client-hub q=alpha") }
        await server.release("/api/client-hub", body: clients(["Acme", "Zenith"]))
        await store.searchClients("   ")
        await server.release("/api/client-hub q=alpha", body: clients(["Alpha Co"]))
        await typed.value

        XCTAssertEqual(store.clients.map(\.name), ["Acme", "Zenith"])
        XCTAssertEqual(store.clientsQuery, "")
    }

    func testLoadMoreUsesTheQueryThatProducedTheCursorAndIsDroppedIfTheSearchChanges() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server)
        await store.refresh()
        await server.release("/api/client-hub q=alpha", body: clients(["Alpha 1"], next: "a2"))
        await store.searchClients("alpha")

        // Paging sends the query the cursor came from.
        await server.release("/api/client-hub q=alpha cursor=a2", body: clients(["Alpha 1", "Alpha 2"], next: "a3"))
        await store.loadMoreClients()
        XCTAssertEqual(store.clients.map(\.name), ["Alpha 1", "Alpha 2"], "duplicates are not appended")
        XCTAssertEqual(store.nextCursor, "a3")

        // A page still loading when the search changes belongs to the old list and is dropped.
        let paging = Task { await store.loadMoreClients() }
        await waitUntil("page request") { await server.isWaiting("/api/client-hub q=alpha cursor=a3") }
        await server.release("/api/client-hub q=beta", body: clients(["Beta Co"], next: nil))
        await store.searchClients("beta")
        await server.release("/api/client-hub q=alpha cursor=a3", body: clients(["Alpha 3"], next: "a4"))
        await paging.value

        XCTAssertEqual(store.clients.map(\.name), ["Beta Co"])
        XCTAssertEqual(store.clientsQuery, "beta")
        XCTAssertNil(store.nextCursor)
        let mixed = await server.count("/api/client-hub q=beta cursor=a3")
        XCTAssertEqual(mixed, 0, "an old cursor is never sent with a new query")
    }

    func testSessionSucceedsThenAReadSaysSignedOutClearsEverything() async {
        for failing in ["/api/dashboard", "/api/operations", "/api/tasks", "/api/client-hub"] {
            let server = HeldServer()
            let store = makeStore(server)
            await allowRefresh(server)
            await store.refresh()
            XCTAssertEqual(store.state, .ready)

            // Second refresh: the session check passes, then one read is answered by the sign-in redirect.
            await server.release("/api/session", body: sessionBody)
            for path in ["/api/dashboard", "/api/operations", "/api/tasks", "/api/client-hub"] where path != failing {
                await server.release(path, body: path == "/api/client-hub" ? clients(["Acme"]) : "{}")
            }
            await server.release(failing, status: 302, body: "", type: "text/html")
            await store.refresh()

            XCTAssertEqual(store.state, .signedOut, failing)
            XCTAssertNil(store.user, failing)
            XCTAssertNil(store.dashboard, failing)
            XCTAssertNil(store.operations, failing)
            XCTAssertNil(store.tasks, failing)
            XCTAssertTrue(store.clients.isEmpty, failing)
            XCTAssertNil(store.nextCursor, failing)
        }
    }

    func testForbiddenForOneAreaClearsOnlyThatArea() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server)
        await store.refresh()

        await server.release("/api/session", body: sessionBody)
        await server.release("/api/dashboard", body: #"{"operations":[],"tasks":[]}"#)
        await server.release("/api/operations", body: #"{"operations":[]}"#)
        await server.release("/api/tasks", status: 403, body: #"{"error":"no"}"#)
        await server.release("/api/client-hub", status: 403, body: #"{"error":"no"}"#)
        await store.refresh()

        XCTAssertEqual(store.state, .ready)
        XCTAssertNil(store.tasks)
        XCTAssertEqual(store.tasksFreshness, .denied)
        XCTAssertTrue(store.clients.isEmpty)
        XCTAssertEqual(store.clientsFreshness, .denied)
        XCTAssertEqual(store.operationsFreshness, .current)
        XCTAssertNotNil(store.dashboard)
    }

    func testTransientFailureKeepsLastGoodDataAndLabelsIt() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server)
        await store.refresh()

        await server.release("/api/session", body: sessionBody)
        await server.release("/api/dashboard", status: 503, body: "{}")
        await server.release("/api/operations", status: 500, body: "{}")
        await server.release("/api/tasks", body: #"{"tasks":[]}"#)
        await server.release("/api/client-hub", status: 503, body: "{}")
        await store.refresh()

        XCTAssertEqual(store.state, .ready)
        XCTAssertEqual(store.dashboard?.operations.count, 1, "earlier dashboard is kept")
        XCTAssertEqual(store.dashboardFreshness, .notRefreshed(.busy))
        XCTAssertEqual(store.operations?.count, 1)
        XCTAssertEqual(store.operationsFreshness, .notRefreshed(.busy))
        XCTAssertEqual(store.tasks?.count, 0)
        XCTAssertEqual(store.tasksFreshness, .current)
        XCTAssertEqual(store.clients.map(\.name), ["Acme"], "same query: earlier rows are kept")
        XCTAssertEqual(store.clientsFreshness, .notRefreshed(.busy))

        // A failed search for a different query must not leave the old query's rows on screen.
        await server.release("/api/client-hub q=zed", status: 503, body: "{}")
        await store.searchClients("zed")
        XCTAssertTrue(store.clients.isEmpty)
        XCTAssertEqual(store.clientsQuery, "zed")
        XCTAssertEqual(store.clientsFreshness, .notRefreshed(.busy))

        // The session check itself failing later keeps data but marks every area.
        await server.release("/api/session", status: 500, body: "{}")
        await store.refresh()
        XCTAssertEqual(store.state, .ready)
        XCTAssertEqual(store.user?.displayName, "Pat")
        XCTAssertEqual(store.tasksFreshness, .notRefreshed(.busy))
    }

    func testFirstLoadFailuresMapToTheRightScreens() async {
        for (status, type, expected) in [(302, "text/html", OpsWorkspaceStore.State.signedOut), (403, "application/json", .forbidden),
                                         (500, "application/json", .serverTrouble), (418, "application/json", .unavailable)] {
            let server = HeldServer()
            let store = makeStore(server)
            await server.release("/api/session", status: status, body: "{}", type: type)
            await store.refresh()
            XCTAssertEqual(store.state, expected, "\(status)")
            XCTAssertNil(store.user)
        }
    }

    func testSignOutWhileRequestsArePendingIgnoresTheirAnswers() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server)
        await store.refresh()

        // A refresh and a search are both waiting on the server when the person signs out.
        await server.release("/api/session", body: sessionBody)
        let refreshing = Task { await store.refresh() }
        await waitUntil("refresh reads") { await server.isWaiting("/api/dashboard") }
        var cleared = false
        await store.signOut { cleared = true }
        XCTAssertTrue(cleared)
        XCTAssertEqual(store.state, .signedOut)

        await server.release("/api/dashboard", body: #"{"operations":[{"id":"x","title":"Late"}],"tasks":[]}"#)
        await server.release("/api/operations", body: #"{"operations":[{"id":"x","title":"Late"}]}"#)
        await server.release("/api/tasks", body: #"{"tasks":[{"id":"x","title":"Late"}]}"#)
        await server.release("/api/client-hub", body: clients(["Late Co"], next: "late"))
        await refreshing.value

        XCTAssertEqual(store.state, .signedOut)
        XCTAssertNil(store.user)
        XCTAssertNil(store.dashboard)
        XCTAssertNil(store.operations)
        XCTAssertNil(store.tasks)
        XCTAssertTrue(store.clients.isEmpty)
        XCTAssertNil(store.nextCursor)

        // Searching and paging do nothing while signed out.
        await store.searchClients("anything")
        await store.loadMoreClients()
        let searched = await server.count("/api/client-hub q=anything")
        XCTAssertEqual(searched, 0)
    }

    func testSearchStartedDuringAFailingSessionCheckCannotRepopulateData() async {
        for (status, type, expected) in [(401, "application/json", OpsWorkspaceStore.State.signedOut),
                                         (302, "text/html", .signedOut), (403, "application/json", .forbidden)] {
            let server = HeldServer()
            let store = makeStore(server)
            await allowRefresh(server)
            await store.refresh()

            // The session check of a second refresh is held; the store still shows the earlier data as ready.
            let refreshing = Task { await store.refresh() }
            await waitUntil("held session check") {
                let asked = await server.count("/api/session"), held = await server.isWaiting("/api/session")
                return asked == 2 && held
            }
            XCTAssertEqual(store.state, .ready)
            let searching = Task { await store.searchClients("late") }
            await waitUntil("search request") { await server.isWaiting("/api/client-hub q=late") }

            // Authority is lost first; the search then answers successfully.
            await server.release("/api/session", status: status, body: "{}", type: type)
            await refreshing.value
            XCTAssertEqual(store.state, expected, "\(status)")
            await server.release("/api/client-hub q=late", body: clients(["Late Co"], next: "late-2"))
            await searching.value

            XCTAssertEqual(store.state, expected, "\(status)")
            XCTAssertNil(store.user, "\(status)")
            XCTAssertTrue(store.clients.isEmpty, "\(status)")
            XCTAssertNil(store.nextCursor, "\(status)")
            XCTAssertEqual(store.clientsQuery, "", "\(status)")
            XCTAssertNil(store.dashboard, "\(status)")
            XCTAssertNil(store.operations, "\(status)")
            XCTAssertNil(store.tasks, "\(status)")
            XCTAssertFalse(store.loadingClients, "\(status)")
        }
    }

    func testADifferentAccountNeverSeesThePreviousAccountsData() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server, next: "c1")
        await store.refresh()
        XCTAssertEqual(store.user?.email, "pat@example.com")

        // The next session check is held while the previous account's search goes out.
        let refreshing = Task { await store.refresh() }
        await waitUntil("held session check") {
                let asked = await server.count("/api/session"), held = await server.isWaiting("/api/session")
                return asked == 2 && held
            }
        let searching = Task { await store.searchClients("pats") }
        await waitUntil("search request") { await server.isWaiting("/api/client-hub q=pats") }

        // A different account answers the session check, and every read for it fails for a passing reason.
        await server.release("/api/session", body: #"{"user":{"email":"sam@example.com","displayName":"Sam","profileType":"Employee"}}"#)
        for path in ["/api/dashboard", "/api/operations", "/api/tasks", "/api/client-hub q=pats"] {
            await server.release(path, status: 503, body: "{}")
        }
        // The refresh reloads the previous query text for the new account; that request also fails.
        await server.release("/api/client-hub", status: 503, body: "{}")
        await refreshing.value
        await searching.value

        XCTAssertEqual(store.state, .ready)
        XCTAssertEqual(store.user?.email, "sam@example.com")
        XCTAssertNil(store.dashboard, "the previous account's dashboard is not kept as earlier information")
        XCTAssertNil(store.operations)
        XCTAssertNil(store.tasks)
        XCTAssertTrue(store.clients.isEmpty)
        XCTAssertNil(store.nextCursor)
        XCTAssertEqual(store.dashboardFreshness, .notRefreshed(.busy))

        // The same account refreshing again does keep its own data through a passing failure.
        await server.release("/api/session", body: #"{"user":{"email":"sam@example.com","displayName":"Sam","profileType":"Employee"}}"#)
        await server.release("/api/dashboard", body: #"{"operations":[{"id":"s1","title":"Sam's"}],"tasks":[]}"#)
        await server.release("/api/operations", body: #"{"operations":[]}"#)
        await server.release("/api/tasks", body: #"{"tasks":[]}"#)
        await server.release("/api/client-hub", body: clients(["Sam Co"]))
        await store.refresh()
        await server.release("/api/session", body: #"{"user":{"email":"sam@example.com","displayName":"Sam","profileType":"Employee"}}"#)
        for path in ["/api/dashboard", "/api/operations", "/api/tasks", "/api/client-hub"] { await server.release(path, status: 503, body: "{}") }
        await store.refresh()
        XCTAssertEqual(store.dashboard?.operations.first?.title, "Sam's")
        XCTAssertEqual(store.clients.map(\.name), ["Sam Co"])
    }

    /// A stand-in for a scoped read-only source: no cookies, no website, some areas not provided.
    private struct PartialSource: OpsWorkspaceDataSource {
        let allowsWebFallback = false
        let failSession: OpsWorkspaceError?
        func session() async throws -> OpsWorkspaceUser {
            if let failSession { throw failSession }
            return OpsWorkspaceUser(displayName: "Pat", email: "pat@example.com", profileType: "Employee")
        }
        func dashboard() async throws -> OpsWorkspaceDashboard { throw OpsWorkspaceError.notOffered }
        func operations() async throws -> [OpsWorkspaceFieldOperation] {
            [OpsWorkspaceFieldOperation(id: "op1", title: "Survey", status: "scheduled", scheduledStart: nil, scheduledEnd: nil,
                                        location: nil, notes: nil, project: nil, division: nil)]
        }
        func tasks() async throws -> [OpsWorkspaceFieldTask] { throw OpsWorkspaceError.notOffered }
        func clients(search: String, cursor: String?) async throws -> OpsWorkspaceClientPage {
            if search == "none" { throw OpsWorkspaceError.notOffered }
            return OpsWorkspaceClientPage(clients: [OpsWorkspaceClient(id: "c1", name: "Acme \(cursor ?? "first")", kind: "organization",
                                                                       sourceName: nil, lastActivity: nil, detailPath: nil)],
                                          nextCursor: cursor == nil ? "p2" : nil)
        }
    }

    func testAnotherDataSourceCanBeInjectedAndAreasItDoesNotOfferStayEmpty() async {
        let store = OpsWorkspaceStore(api: PartialSource(failSession: nil))
        XCTAssertFalse(store.allowsWebFallback)
        await store.refresh()
        XCTAssertEqual(store.state, .ready)
        XCTAssertNil(store.dashboard)
        XCTAssertEqual(store.dashboardFreshness, .notOffered)
        XCTAssertNil(store.tasks)
        XCTAssertEqual(store.tasksFreshness, .notOffered)
        XCTAssertEqual(store.operations?.count, 1)
        XCTAssertEqual(store.operationsFreshness, .current)
        XCTAssertEqual(store.clients.map(\.name), ["Acme first"])
        await store.loadMoreClients()
        XCTAssertEqual(store.clients.map(\.name), ["Acme first"], "same id is not duplicated")
        XCTAssertNil(store.nextCursor)
        await store.searchClients("none")
        XCTAssertTrue(store.clients.isEmpty)
        XCTAssertEqual(store.clientsFreshness, .notOffered)

        // A later passing failure of the session check does not turn "not offered" into "earlier information".
        let failing = OpsWorkspaceStore(api: PartialSource(failSession: .signedOut))
        await failing.refresh()
        XCTAssertEqual(failing.state, .signedOut)
        XCTAssertTrue(OpsWorkspaceStore(api: OpsWorkspaceAPI(origin: origin, cookies: { nil })).allowsWebFallback)
    }

    func testSignedOutDuringSearchOrPagingClearsEverything() async {
        let server = HeldServer()
        let store = makeStore(server)
        await allowRefresh(server, next: "c1")
        await store.refresh()
        await server.release("/api/client-hub cursor=c1", status: 401, body: "{}")
        await store.loadMoreClients()
        XCTAssertEqual(store.state, .signedOut)
        XCTAssertNil(store.operations)

        let again = HeldServer()
        let other = makeStore(again)
        await allowRefresh(again)
        await other.refresh()
        await again.release("/api/client-hub q=a", body: "<html>Sign in</html>", type: "text/html")
        await other.searchClients("a")
        XCTAssertEqual(other.state, .signedOut)
        XCTAssertNil(other.user)
    }
}
