import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LTOpsCore

private actor ScopedCredentialBox {
    var value: ManagedOAuthCredential?
    init(_ value: ManagedOAuthCredential?) { self.value = value }
    func get() -> ManagedOAuthCredential? { value }
    func clear() { value = nil }
}

private final class ScopedScenario: @unchecked Sendable {
    let lock = NSLock()
    private var requests: [URLRequest] = []
    var status = 200
    var sessionStatus = 200
    var delay: TimeInterval = 0
    var serverLifetime = 600
    var operationCycle = false
    func receive(_ request: URLRequest) -> (Int, String, TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
        let url = request.url!
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
        let root = #"{"sourceId":"project-alpha:staging","rootNamespace":"business","kind":"organization","clientHubRootId":"root/a","name":"Acme"}"#
        switch url.path {
        case "/mobile-pilot/v1/session":
            return (sessionStatus, "{\"schemaVersion\":1,\"readOnly\":true,\"user\":{\"id\":\"staff-1\",\"displayName\":\"Pat\",\"email\":\"pat@example.test\"},\"expiresAt\":\(Int(Date().timeIntervalSince1970)+serverLifetime)}", 0)
        case "/mobile-pilot/v1/operations":
            let id = cursor == nil ? "one" : "two"
            let next = cursor == nil || operationCycle ? "\"second\"" : "null"
            return (status, "{\"schemaVersion\":1,\"operations\":[{\"id\":\"\(id)\",\"title\":\"Survey\",\"status\":\"scheduled\",\"scheduledStart\":null,\"scheduledEnd\":null,\"location\":null,\"projectName\":\"Site\",\"divisionName\":null}],\"nextCursor\":\(next)}", delay)
        case "/mobile-pilot/v1/business-roots":
            return (status, "{\"schemaVersion\":1,\"roots\":[\(root)],\"nextCursor\":\(cursor == nil ? "\"second\"" : "null")}", delay)
        default:
            if url.absoluteString.contains("/business-roots/organization/root%2Fa/projects") {
                return (status, #"{"schemaVersion":1,"projects":[{"id":"project-1","origin":"canonical","name":"Site","status":"active","startDate":null,"endDate":null}],"nextCursor":null}"#, delay)
            }
            return (404, "{}", 0)
        }
    }
    func seen() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}

private final class ScopedStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var scenario = ScopedScenario()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body, delay) = Self.scenario.receive(request)
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                      headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ScopedPilotDataSourceTests: XCTestCase, @unchecked Sendable {
    private func make(_ scenario: ScopedScenario = ScopedScenario(), business: Bool = true,
                      credential: Bool = true) throws -> (ScopedPilotDataSource, ScopedCredentialBox) {
        ScopedStub.scenario = scenario
        let resource = "https://pilot.example.test", issuer = "https://access.example.test"
        let pins = try ManagedOAuthPins(resource: resource, issuer: issuer,
            authorizationEndpoint: issuer + "/authorize", tokenEndpoint: issuer + "/token",
            registrationEndpoint: issuer + "/register", revocationEndpoint: issuer + "/revoke")
        let box = ScopedCredentialBox(credential ? ManagedOAuthCredential(accessToken: "oauth:synthetic-test",
            refreshToken: nil, expiresAt: Date().addingTimeInterval(3600)) : nil)
        let api = ManagedPilotDataAPI(pins: pins, protocolClasses: [ScopedStub.self],
                                     businessOrigins: business ? [resource] : [])
        return (ScopedPilotDataSource(api: api, credential: { await box.get() }), box)
    }

    func testSessionAndCompleteOperationsUseOnlyNarrowCookieFreeReads() async throws {
        let scenario = ScopedScenario(), (source, _) = try make(scenario)
        let user = try await source.session()
        XCTAssertEqual(user.id, "staff-1")
        XCTAssertEqual(user.profileType, "", "the contract does not disclose a role")
        let operations = try await source.operations()
        XCTAssertEqual(operations.map(\.id), ["one", "two"])
        XCTAssertEqual(operations.first?.project, "Site")
        XCTAssertNil(operations.first?.notes)
        XCTAssertFalse(source.allowsWebFallback)
        XCTAssertFalse(source.searchesAllClients)
        for request in scenario.seen() {
            XCTAssertEqual(request.url?.host, "pilot.example.test")
            XCTAssertTrue(request.url!.path.hasPrefix("/mobile-pilot/v1/"))
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer oauth:synthetic-test")
        }
        do { _ = try await source.dashboard(); XCTFail("invented dashboard") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .notOffered) }
        do { _ = try await source.tasks(); XCTFail("invented tasks") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .notOffered) }
        XCTAssertEqual(scenario.seen().count, 3)
    }

    func testFilteredEmptyClientPageKeepsBoundCursorAndProjectsUseFullIdentity() async throws {
        let scenario = ScopedScenario(), (source, _) = try make(scenario)
        _ = try await source.session()
        let first = try await source.clients(search: "missing", cursor: nil)
        XCTAssertTrue(first.clients.isEmpty)
        XCTAssertNotNil(first.nextCursor)
        let second = try await source.clients(search: "missing", cursor: first.nextCursor)
        XCTAssertNil(second.nextCursor)
        do { _ = try await source.clients(search: "Acme", cursor: first.nextCursor); XCTFail("changed cursor query") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .unavailable) }
        let clients = try await source.clients(search: "", cursor: nil)
        let client = try XCTUnwrap(clients.clients.first)
        XCTAssertNil(client.detailPath)
        XCTAssertEqual(client.sourceName, "project-alpha:staging")
        let projects = try await source.projects(client: client)
        XCTAssertEqual(projects.projects.first?.idValue, "project-1")
        let request = try XCTUnwrap(scenario.seen().last)
        XCTAssertTrue(request.url!.absoluteString.contains("root%2Fa/projects"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    }

    func testMissingCredentialsAndRevocationSignOutWithoutFallback() async throws {
        let empty = ScopedScenario(), (missing, _) = try make(empty, credential: false)
        do { _ = try await missing.session(); XCTFail("missing credential") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        XCTAssertTrue(empty.seen().isEmpty)
        let scenario = ScopedScenario(), (source, box) = try make(scenario)
        _ = try await source.session()
        await box.clear()
        do { _ = try await source.operations(); XCTFail("signed-out credential") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        XCTAssertEqual(scenario.seen().count, 1)
        let revoked = ScopedScenario()
        revoked.status = 401
        let (revokedSource, _) = try make(revoked)
        _ = try await revokedSource.session()
        do { _ = try await revokedSource.operations(); XCTFail("revoked authority") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        do { _ = try await revokedSource.clients(search: "", cursor: nil); XCTFail("retained authority") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        XCTAssertEqual(revoked.seen().count, 2)
    }

    func testServerExpiryBoundsLongerCredential() async throws {
        let scenario = ScopedScenario()
        scenario.serverLifetime = 2
        let (source, _) = try make(scenario)
        _ = try await source.session()
        try await Task.sleep(nanoseconds: 2_100_000_000)
        do { _ = try await source.operations(); XCTFail("server expiry ignored") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        XCTAssertEqual(scenario.seen().count, 1)
    }

    func testSignOutWhileReadIsPendingDropsItsSuccessfulResult() async throws {
        let scenario = ScopedScenario()
        scenario.delay = 0.15
        let (source, _) = try make(scenario)
        _ = try await source.session()
        let read = Task { try await source.operations() }
        for _ in 0..<200 {
            if scenario.seen().count > 1 { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertGreaterThan(scenario.seen().count, 1)
        await source.invalidate()
        do { _ = try await read.value; XCTFail("late success after sign-out") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        XCTAssertEqual(scenario.seen().count, 2, "no next page may be sent after invalidation")
    }

    func testWithdrawnFacadeClearsAuthorityAndWithdrawnAreaIsNotTransient() async throws {
        let scenario = ScopedScenario(), (source, _) = try make(scenario)
        _ = try await source.session()
        scenario.status = 404
        do { _ = try await source.operations(); XCTFail("withdrawn area") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .notOffered) }
        scenario.sessionStatus = 404
        do { _ = try await source.session(); XCTFail("withdrawn facade") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        let requests = scenario.seen().count
        do { _ = try await source.operations(); XCTFail("retained withdrawn authority") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .signedOut) }
        XCTAssertEqual(scenario.seen().count, requests)
        let expiry = await source.sessionExpiresAt
        XCTAssertNil(expiry)
    }

    func testBusinessGateRemainsClosedAndOperationsCyclesFail() async throws {
        let scenario = ScopedScenario(), (source, _) = try make(scenario, business: false)
        _ = try await source.session()
        do { _ = try await source.clients(search: "", cursor: nil); XCTFail("unreviewed business service") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .notOffered) }
        XCTAssertEqual(scenario.seen().count, 1)
        let cycle = ScopedScenario()
        cycle.operationCycle = true
        let (cyclicSource, _) = try make(cycle)
        _ = try await cyclicSource.session()
        do { _ = try await cyclicSource.operations(); XCTFail("cursor cycle") }
        catch { XCTAssertEqual(error as? OpsWorkspaceError, .unavailable) }
        XCTAssertEqual(cycle.seen().count, 3)
    }

    func testServerFailuresAreBusyWithoutRemovingCurrentAuthority() async throws {
        for status in [500, 502, 503] {
            let scenario = ScopedScenario(), (source, _) = try make(scenario)
            _ = try await source.session()
            scenario.status = status
            do { _ = try await source.operations(); XCTFail("server failure") }
            catch { XCTAssertEqual(error as? OpsWorkspaceError, .busy, "\(status)") }
            let expiry = await source.sessionExpiresAt
            XCTAssertNotNil(expiry)
        }
    }
}
