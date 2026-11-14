import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LTOpsCore

final class OpsWorkspaceTests: XCTestCase {
    private let origin = WebShellOrigin(configured: "https://ops.example.com")!

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [URLRequest] = []
        func add(_ request: URLRequest) { lock.lock(); stored.append(request); lock.unlock() }
        var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return stored }
    }

    private func api(status: Int = 200, type: String = "application/json; charset=utf-8", body: String,
                     cookie: String? = "CF_Authorization=abc", recorder: Recorder = Recorder(),
                     responseURL: String? = nil) -> OpsWorkspaceAPI {
        OpsWorkspaceAPI(origin: origin, cookies: { cookie }, transport: { request in
            recorder.add(request)
            let url = responseURL.flatMap(URL.init(string:)) ?? request.url!
            return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!)
        })
    }

    func testSessionReadsTheSignedInUser() async throws {
        let recorder = Recorder()
        let user = try await api(body: #"{"user":{"id":7,"email":"pat@example.com","displayName":"Pat","profileType":"Administrator"},"csrfToken":"x"}"#,
                                 recorder: recorder).session()
        XCTAssertEqual(user, OpsWorkspaceUser(displayName: "Pat", email: "pat@example.com", profileType: "Administrator"))
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://ops.example.com/api/session")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "CF_Authorization=abc")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testDashboardMapsRowsAndToleratesMissingFields() async throws {
        let body = #"""
        {"operations":[{"id":12,"title":"North field","status":"planned","scheduled_start":"2026-11-14T15:00:00Z","division_name":"Survey"},
                       {"id":"op-2","title":"Roof"},{"title":"no id"},"junk"],
         "tasks":[{"id":3,"title":"Charge batteries","status":"open","due_at":null}],
         "airspace":{"activeTfrs":2,"scheduledTfrs":1},
         "integrations":[{"integration":"project-alpha","stale":true}]}
        """#
        let dashboard = try await api(body: body).dashboard()
        XCTAssertEqual(dashboard.operations.map(\.id), ["12", "op-2"])
        XCTAssertEqual(dashboard.operations[0].division, "Survey")
        XCTAssertEqual(dashboard.operations[1].status, "")
        XCTAssertEqual(dashboard.tasks, [OpsWorkspaceTask(id: "3", title: "Charge batteries", status: "open", dueAt: nil)])
        XCTAssertEqual(dashboard.activeTfrs, 2)
        XCTAssertEqual(dashboard.scheduledTfrs, 1)
        XCTAssertTrue(dashboard.dataMayBeStale)
        let empty = try await api(body: "{}").dashboard()
        XCTAssertEqual(empty, OpsWorkspaceDashboard(operations: [], tasks: [], activeTfrs: 0, scheduledTfrs: 0, dataMayBeStale: false))
    }

    func testOperationsListMapsRowsAndFilters() async throws {
        let recorder = Recorder()
        let body = #"""
        {"operations":[
          {"id":"op_1","title":"North field survey","status":"in_progress","scheduled_start":"2026-11-14T15:00:00Z","scheduled_end":"2026-11-14T18:00:00Z","location":"Cedar Farm","notes":"Bring RTK base","project_name":"Cedar 2026","division_name":"Survey","payload_json":"{}"},
          {"id":"op_2","title":"Roof inspection","status":"completed","project_name":"Harbor Works"},
          {"id":"op_3","title":"Tower check","status":"cancelled"},
          {"id":"op_4","title":"Quarry volume","status":"scheduled","location":"East Quarry"},
          {"status":"draft"}]}
        """#
        let operations = try await api(body: body, recorder: recorder).operations()
        XCTAssertEqual(recorder.requests.first?.url?.path, "/api/operations")
        XCTAssertEqual(operations.map(\.id), ["op_1", "op_2", "op_3", "op_4"])
        XCTAssertEqual(operations[0].notes, "Bring RTK base")
        XCTAssertEqual(operations[0].statusLabel, "In Progress")
        XCTAssertEqual(operations.filtered(.open, search: "").map(\.id), ["op_1", "op_4"])
        XCTAssertEqual(operations.filtered(.completed, search: "").map(\.id), ["op_2"])
        XCTAssertEqual(operations.filtered(.all, search: "").count, 4)
        XCTAssertEqual(operations.filtered(.all, search: "  HARBOR ").map(\.id), ["op_2"])
        XCTAssertEqual(operations.filtered(.open, search: "quarry").map(\.id), ["op_4"])
        XCTAssertEqual(operations.filtered(.open, search: "survey").map(\.id), ["op_1"])
        XCTAssertTrue(operations.filtered(.open, search: "nothing here").isEmpty)
        XCTAssertEqual(OpsWorkspaceOperationFilter.allCases.map(\.label), ["Open", "All", "Completed"])
        let empty = try await api(body: "{}").operations()
        XCTAssertTrue(empty.isEmpty)
    }

    func testClientsSendSearchAndCursorAndKeepOnlySafeDetailPaths() async throws {
        let recorder = Recorder()
        let body = #"""
        {"clients":[
          {"source_id":"project-alpha:staging","root_namespace":"business","kind":"organization","public_id":"org_1","display_name":"Cedar Farm","source_name":"Staging","detail_path":"/clients/organizations/org_1","meaningful_activity_at":"2026-11-10T00:00:00Z"},
          {"source_id":"project-alpha:staging","root_namespace":"business","kind":"standalone_client","public_id":"c_2","display_name":"Harbor Works","detail_path":"https://evil.example.org/x"},
          {"source_id":"project-alpha:staging","kind":"organization","public_id":"org_3"}],
         "nextCursor":"abc_123"}
        """#
        let page = try await api(body: body, recorder: recorder).clients(search: "  cedar & co ", cursor: "cur-1")
        XCTAssertEqual(page.clients.map(\.name), ["Cedar Farm", "Harbor Works"])
        XCTAssertEqual(page.clients[0].id, "project-alpha:staging|business|organization|org_1")
        XCTAssertEqual(page.clients[0].detailPath, "/clients/organizations/org_1")
        XCTAssertEqual(page.clients[0].kindLabel, "Organization")
        XCTAssertNil(page.clients[1].detailPath)
        XCTAssertEqual(page.clients[1].kindLabel, "Client")
        XCTAssertEqual(page.nextCursor, "abc_123")
        let url = try XCTUnwrap(recorder.requests.first?.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(url.path, "/api/client-hub")
        XCTAssertEqual(items.first { $0.name == "q" }?.value, "cedar & co")
        XCTAssertEqual(items.first { $0.name == "cursor" }?.value, "cur-1")
        XCTAssertEqual(items.first { $0.name == "limit" }?.value, "50")
        XCTAssertEqual(WebShellOrigin(url: url), origin)
    }

    func testObserverSeesPathAndStatusOnly() async {
        final class Seen: @unchecked Sendable {
            private let lock = NSLock(); private var items: [String] = []
            func add(_ item: String) { lock.lock(); items.append(item); lock.unlock() }
            var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
        }
        let seen = Seen()
        let ok = OpsWorkspaceAPI(origin: origin, cookies: { "c=1" }, transport: { request in
            (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!)
        }, observer: { path, status in seen.add("\(path) \(status)") })
        _ = try? await ok.clients(search: "secret name")
        let offline = OpsWorkspaceAPI(origin: origin, cookies: { "c=1" }, transport: { _ in throw URLError(.timedOut) },
                                      observer: { path, status in seen.add("\(path) \(status)") })
        _ = try? await offline.dashboard()
        XCTAssertEqual(seen.all, ["/api/client-hub 503", "/api/dashboard 0"])
    }

    func testSafePathRejectsAnythingButAPlainSitePath() {
        XCTAssertEqual(OpsWorkspaceAPI.safePath("/clients/organizations/org_1"), "/clients/organizations/org_1")
        for bad in ["", "clients", "//evil.example.org", "https://evil.example.org/", "/a?b=1", "/a#b", "/a/../b", "/a b", "/\\evil"] {
            XCTAssertNil(OpsWorkspaceAPI.safePath(bad), bad)
        }
    }

    func testSignedOutForbiddenAndUnavailableAreDistinct() async {
        func outcome(_ api: OpsWorkspaceAPI) async -> OpsWorkspaceError? {
            do { _ = try await api.session(); return nil } catch { return error as? OpsWorkspaceError }
        }
        let recorder = Recorder()
        let noCookie = await outcome(api(body: "{}", cookie: nil, recorder: recorder))
        XCTAssertEqual(noCookie, .signedOut)
        XCTAssertTrue(recorder.requests.isEmpty, "no request is sent without a session")
        let emptyCookie = await outcome(api(body: "{}", cookie: ""))
        XCTAssertEqual(emptyCookie, .signedOut)
        let unauthorized = await outcome(api(status: 401, body: "{}"))
        XCTAssertEqual(unauthorized, .signedOut)
        let redirected = await outcome(api(status: 302, type: "text/html", body: ""))
        XCTAssertEqual(redirected, .signedOut)
        let loginPage = await outcome(api(type: "text/html", body: "<html>Sign in</html>"))
        XCTAssertEqual(loginPage, .signedOut)
        let forbidden = await outcome(api(status: 403, body: #"{"error":"no"}"#))
        XCTAssertEqual(forbidden, .forbidden)
        let serverError = await outcome(api(status: 500, body: "{}"))
        XCTAssertEqual(serverError, .unavailable)
        let preparing = await outcome(api(status: 503, body: #"{"error":"being prepared"}"#))
        XCTAssertEqual(preparing, .busy)
        let notJson = await outcome(api(body: "[1,2]"))
        XCTAssertEqual(notJson, .unavailable)
        let missingUser = await outcome(api(body: #"{"user":{}}"#))
        XCTAssertEqual(missingUser, .unavailable)
        let otherHost = await outcome(api(body: #"{"user":{"email":"a@example.com"}}"#, responseURL: "https://elsewhere.example.org/api/session"))
        XCTAssertEqual(otherHost, .unavailable)
        let failing = OpsWorkspaceAPI(origin: origin, cookies: { "c=1" }, transport: { _ in throw URLError(.notConnectedToInternet) })
        let offline = await outcome(failing)
        XCTAssertEqual(offline, .unavailable)
    }
}
