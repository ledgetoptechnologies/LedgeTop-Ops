#if os(iOS)
import SwiftUI
import WebKit
import os
#if SWIFT_PACKAGE
import LTOpsCore
#endif

// Native workspace: Home and Clients are SwiftUI screens that read the Ops
// data API directly. The embedded web view is used for sign-in and as the
// fallback for pages that are not native yet.

@MainActor
final class NativeWorkspaceModel: ObservableObject {
    typealias State = OpsWorkspaceStore.State
    /// The text in the Clients search field. Results always belong to `store.clientsQuery`.
    @Published var search = ""

    let configuration: WebShellConfiguration
    private let store: OpsWorkspaceStore
    private nonisolated static let log = Logger(subsystem: "com.ledgetoptechnologies.ops.pilot", category: "native")
    private func note(_ text: String) { NativeWorkspaceModel.log.notice("native \(text, privacy: .public)") }

    var state: State { store.state }
    var user: OpsWorkspaceUser? { store.user }
    var dashboard: OpsWorkspaceDashboard? { store.dashboard }
    var operations: [OpsWorkspaceFieldOperation]? { store.operations }
    var tasks: [OpsWorkspaceFieldTask]? { store.tasks }
    var clients: [OpsWorkspaceClient] { store.clients }
    var clientsQuery: String { store.clientsQuery }
    var nextCursor: String? { store.nextCursor }
    var loadingClients: Bool { store.loadingClients }
    /// False in read-only mode: nothing in the app may open the full website.
    var allowsWebFallback: Bool { store.allowsWebFallback }
    /// False when client search only narrows the clients already loaded.
    var searchesAllClients: Bool { store.searchesAllClients }
    var dashboardNotice: String? { NativeWorkspaceModel.notice(store.dashboardFreshness, what: "the dashboard", hasData: store.dashboard != nil) }
    var operationsNotice: String? { NativeWorkspaceModel.notice(store.operationsFreshness, what: "operations", hasData: store.operations != nil) }
    var tasksNotice: String? { NativeWorkspaceModel.notice(store.tasksFreshness, what: "tasks", hasData: store.tasks != nil) }
    var clientsNotice: String? { NativeWorkspaceModel.notice(store.clientsFreshness, what: "the client list", hasData: !store.clients.isEmpty) }

    init?(configuration: WebShellConfiguration) {
        guard let origin = WebShellOrigin(url: configuration.start) else { return nil }
        self.configuration = configuration
        let api = OpsWorkspaceAPI(origin: origin, cookies: { await NativeWorkspaceModel.cookieHeader(for: origin) },
                                  observer: { path, status in
                                      NativeWorkspaceModel.log.notice("native api \(path, privacy: .public) \(status, privacy: .public)")
                                  })
        let warmUp = WebSessionWarmUp()
        // After a cold start the saved web session is not readable until a web view has run once.
        store = OpsWorkspaceStore(api: api, prepare: { await warmUp.run(origin: origin) })
        store.onChange = { [weak self] in self?.objectWillChange.send() }
    }

    /// The signed-in web session's cookies for the workspace host, as a request header. Native code only.
    static func cookieHeader(for origin: WebShellOrigin) async -> String? {
        let now = Date()
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies().filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            let matches = origin.host == domain || (cookie.domain.hasPrefix(".") && origin.host.hasSuffix("." + domain))
            return matches && cookie.isSecure && (cookie.expiresDate.map { $0 > now } ?? true)
        }
        guard !cookies.isEmpty else { return nil }
        return cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    /// What to tell the person when an area is not current. Nil when it is.
    static func notice(_ freshness: OpsWorkspaceFreshness, what: String, hasData: Bool) -> String? {
        switch freshness {
        case .idle, .current: return nil
        case .denied: return "This account can't view \(what)."
        case .notOffered: return "\(what.prefix(1).uppercased() + what.dropFirst()) isn't available in this version of the app yet."
        case .notRefreshed(.busy):
            return hasData ? "Showing earlier information. The Ledge Top server couldn't update \(what) just now."
                           : "The Ledge Top server couldn't provide \(what) yet. Try again shortly."
        case .notRefreshed:
            return hasData ? "Showing earlier information. \(what.prefix(1).uppercased() + what.dropFirst()) couldn't be updated; check your connection."
                           : "\(what.prefix(1).uppercased() + what.dropFirst()) couldn't be loaded. Check your connection and try again."
        }
    }

    func refresh() async {
        await store.refresh(search: search)
        note("state \(String(describing: store.state)) operations=\(store.operations?.count ?? -1) tasks=\(store.tasks?.count ?? -1) clients=\(store.clients.count)")
    }

    func searchClients() async { await store.searchClients(search) }
    func loadMoreClients() async { await store.loadMoreClients() }

    /// Removes the web session and every stored web record, then shows the sign-in screen.
    func signOut() async {
        await store.signOut {
            await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        }
        note("state signedOut (user)")
    }
}

/// Loads the saved web session into memory once per launch. WebKit only reads its cookie store
/// from disk after a web view has loaded something, so native requests made first would look signed out.
@MainActor
final class WebSessionWarmUp: NSObject, WKNavigationDelegate {
    private var view: WKWebView?
    private var waiting: CheckedContinuation<Void, Never>?
    private var done = false

    func run(origin: WebShellOrigin) async {
        guard !done else { return }
        done = true
        let setup = WKWebViewConfiguration()
        setup.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: setup)
        view.navigationDelegate = self
        self.view = view
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiting = continuation
            // An empty local document on the workspace origin: no network request is made.
            view.loadHTMLString("", baseURL: origin.url)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self?.finish()
            }
        }
        self.view = nil
    }

    private func finish() {
        waiting?.resume()
        waiting = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
}

/// Root of the connected app. Shown only in builds that configure a workspace.
struct NativeWorkspaceRoot: View {
    @StateObject private var model: NativeWorkspaceModel
    @State private var tab: String
    @State private var signingIn = false

    init?(configuration: WebShellConfiguration) {
        guard let model = NativeWorkspaceModel(configuration: configuration) else { return nil }
        _model = StateObject(wrappedValue: model)
        // Test hook: `-LTOpsNativeTab clients` starts on a given tab.
        _tab = State(initialValue: UserDefaults.standard.string(forKey: "LTOpsNativeTab") ?? "home")
    }

    var body: some View {
        Group {
            switch model.state {
            case .checking:
                ProgressView("Connecting to Ledge Top")
            case .signedOut:
                ContentUnavailableView {
                    Label("Sign in to Ledge Top", systemImage: "person.crop.circle.badge.checkmark")
                } description: {
                    Text("Use your Ledge Top email. You'll get a code to confirm it's you.")
                } actions: {
                    Button("Sign in") { signingIn = true }.buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("native-sign-in")
                }
            case .forbidden:
                ContentUnavailableView {
                    Label("No access", systemImage: "lock")
                } description: {
                    Text("This account can't open Ledge Top Operations. Ask your Ledge Top admin.")
                } actions: {
                    Button("Sign out") { Task { await model.signOut() } }
                }
            case .serverTrouble:
                ContentUnavailableView {
                    Label("Ledge Top is having a problem", systemImage: "exclamationmark.icloud")
                } description: {
                    Text("Your connection is fine. The Ledge Top server returned an error. Try again shortly.")
                } actions: {
                    Button("Try again") { Task { await model.refresh() } }
                }.accessibilityIdentifier("native-server-trouble")
            case .unavailable:
                ContentUnavailableView {
                    Label("Can't reach Ledge Top", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("Check your connection, then try again.")
                } actions: {
                    Button("Try again") { Task { await model.refresh() } }
                }
            case .ready:
                TabView(selection: $tab) {
                    NavigationStack { NativeHome(model: model) }
                        .tabItem { Label("Home", systemImage: "house") }.tag("home")
                    NavigationStack { NativeOperations(model: model) }
                        .tabItem { Label("Operations", systemImage: "square.stack.3d.up") }.tag("operations")
                    NavigationStack { NativeTasks(model: model) }
                        .tabItem { Label("Tasks", systemImage: "checklist") }.tag("tasks")
                    NavigationStack { NativeClients(model: model) }
                        .tabItem { Label("Clients", systemImage: "person.2") }.tag("clients")
                    NavigationStack { NativeMore(model: model) }
                        .tabItem { Label("More", systemImage: "ellipsis.circle") }.tag("more")
                }
            }
        }
        .tint(Color(red: 0.933, green: 0.314, blue: 0.027))
        .task { await model.refresh() }
        .fullScreenCover(isPresented: $signingIn, onDismiss: { Task { await model.refresh() } }) {
            WebShellScreen(closeWhenSignedIn: true)
        }
    }
}

private struct NativeHome: View {
    @ObservedObject var model: NativeWorkspaceModel
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(Date.now, format: .dateTime.weekday(.wide).month(.wide).day())
                        .font(.caption.weight(.semibold)).foregroundStyle(.tint).textCase(.uppercase)
                    Text("Operations").font(.largeTitle.bold())
                    if let name = model.user?.displayName {
                        Text("Hello, \(name). Here's what needs attention today.").foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 6)
            }
            if model.dashboard?.dataMayBeStale == true {
                Section {
                    Label("Project data may be out of date while synchronization recovers.", systemImage: "exclamationmark.triangle")
                        .font(.subheadline).foregroundStyle(.orange)
                }
            }
            if let notice = model.dashboardNotice {
                Section { Label(notice, systemImage: "exclamationmark.triangle").font(.subheadline) }
            }
            if let board = model.dashboard {
                Section {
                    HStack(alignment: .top) {
                        metric("Open operations", board.operations.count)
                        metric("Open tasks", board.tasks.count)
                        metric("Active TFRs", board.activeTfrs)
                        metric("Scheduled TFRs", board.scheduledTfrs)
                    }
                }
                Section("Upcoming operations") {
                    if board.operations.isEmpty {
                        Text("No open operations.").foregroundStyle(.secondary)
                    } else {
                        ForEach(board.operations) { operation in
                            VStack(alignment: .leading, spacing: 4) {
                                if !operation.status.isEmpty {
                                    Text(operation.status.replacingOccurrences(of: "_", with: " ").uppercased())
                                        .font(.caption2.bold()).foregroundStyle(.tint)
                                }
                                Text(operation.title).font(.headline)
                                if let division = operation.division { Text(division).font(.subheadline).foregroundStyle(.secondary) }
                                if let start = operation.scheduledStart { Label(NativeDates.short(start), systemImage: "clock").font(.caption).foregroundStyle(.secondary) }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                Section("Open tasks") {
                    if board.tasks.isEmpty {
                        Text("No open tasks.").foregroundStyle(.secondary)
                    } else {
                        ForEach(board.tasks) { task in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(task.title)
                                if let due = task.dueAt { Text("Due \(NativeDates.short(due))").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            } else if model.dashboardNotice == nil {
                Section { ProgressView("Loading the dashboard") }
            }
        }
        .navigationTitle("Ledge Top").navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .accessibilityIdentifier("native-home")
    }

    private func metric(_ title: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value, format: .number).font(.title.bold())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NativeOperations: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var search = ""
    @State private var filter = OpsWorkspaceOperationFilter.open
    var body: some View {
        List {
            Section {
                Picker("Show", selection: $filter) {
                    ForEach(OpsWorkspaceOperationFilter.allCases, id: \.self) { Text($0.label).tag($0) }
                }.pickerStyle(.segmented).accessibilityIdentifier("native-operations-filter")
            }
            if let notice = model.operationsNotice {
                Section { Label(notice, systemImage: "exclamationmark.triangle").font(.subheadline) }
            }
            if let operations = model.operations {
                let shown = operations.filtered(filter, search: search)
                if shown.isEmpty {
                    ContentUnavailableView(operations.isEmpty ? "No operations yet" : "No operations found", systemImage: "square.stack.3d.up",
                                           description: Text(operations.isEmpty ? "Scheduled work will appear here." : "Try another search or filter."))
                } else {
                    ForEach(shown) { operation in
                        NavigationLink(value: operation) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(operation.statusLabel.uppercased()).font(.caption2.bold()).foregroundStyle(.tint)
                                Text(operation.title).font(.headline)
                                if let project = operation.project { Text(project).font(.subheadline).foregroundStyle(.secondary) }
                                if let start = operation.scheduledStart {
                                    Label(NativeDates.short(start), systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                }
            } else if model.operationsNotice == nil {
                Section { ProgressView("Loading operations") }
            }
        }
        .navigationTitle("Operations")
        .navigationDestination(for: OpsWorkspaceFieldOperation.self) { NativeOperationDetail(operation: $0) }
        .searchable(text: $search, prompt: "Find an operation, project or site")
        .refreshable { await model.refresh() }
        .accessibilityIdentifier("native-operations")
    }
}

private struct NativeOperationDetail: View {
    let operation: OpsWorkspaceFieldOperation
    var body: some View {
        List {
            Section {
                Text(operation.title).font(.title2.bold())
                LabeledContent("Status", value: operation.statusLabel)
                if let project = operation.project { LabeledContent("Project", value: project) }
                if let division = operation.division { LabeledContent("Division", value: division) }
            }
            Section("Schedule") {
                LabeledContent("Starts", value: operation.scheduledStart.map(NativeDates.short) ?? "Not scheduled")
                if let end = operation.scheduledEnd { LabeledContent("Ends", value: NativeDates.short(end)) }
            }
            if let location = operation.location { Section("Site") { Label(location, systemImage: "mappin.and.ellipse") } }
            if let notes = operation.notes { Section("Notes") { Text(notes) } }
            Section {
                Label("Flight readiness requires your normal operational checks. This app does not provide airspace clearance or flight authorization.", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Operation").navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("native-operation-detail")
    }
}

private struct NativeTasks: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var showCompleted = false
    var body: some View {
        List {
            if let notice = model.tasksNotice {
                Section { Label(notice, systemImage: "exclamationmark.triangle").font(.subheadline) }
            }
            if let tasks = model.tasks {
                let shown = tasks.filter { showCompleted || $0.isOpen }
                Section { Toggle("Show completed", isOn: $showCompleted).accessibilityIdentifier("native-tasks-completed") }
                if shown.isEmpty {
                    ContentUnavailableView(tasks.isEmpty ? "No tasks yet" : "No open tasks", systemImage: "checklist",
                                           description: Text(tasks.isEmpty ? "Assigned work will appear here." : "Turn on Show completed to see finished tasks."))
                } else {
                    ForEach(shown) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.statusLabel.uppercased()).font(.caption2.bold())
                                .foregroundStyle(task.isBlocked ? AnyShapeStyle(.red) : AnyShapeStyle(.tint))
                            Text(task.title).font(.headline)
                            if let context = [task.operation, task.project].compactMap({ $0 }).first {
                                Text(context).font(.subheadline).foregroundStyle(.secondary)
                            }
                            if let notes = task.notes { Text(notes).font(.footnote).foregroundStyle(.secondary).lineLimit(3) }
                            HStack(spacing: 14) {
                                if let due = task.dueAt { Label(NativeDates.short(due), systemImage: "calendar") }
                                if let assignee = task.assignee { Label(assignee, systemImage: "person") }
                            }.font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }
                }
            } else if model.tasksNotice == nil {
                Section { ProgressView("Loading tasks") }
            }
        }
        .navigationTitle("Tasks")
        .refreshable { await model.refresh() }
        .accessibilityIdentifier("native-tasks")
    }
}

private struct NativeClients: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var opened: OpsWorkspaceClient?
    var body: some View {
        List {
            if let notice = model.clientsNotice {
                Section { Label(notice, systemImage: "exclamationmark.triangle"); Button("Try again") { Task { await model.searchClients() } } }
            }
            if model.clients.isEmpty, model.clientsNotice == nil, !model.loadingClients {
                ContentUnavailableView(model.clientsQuery.isEmpty ? "No clients yet" : "No clients found", systemImage: "person.2",
                                       description: Text(model.clientsQuery.isEmpty ? "Clients you can see will appear here." : "Nothing matches \u{201C}\(model.clientsQuery)\u{201D}."))
            }
            if !model.clientsQuery.isEmpty, !model.clients.isEmpty {
                Section {
                    Text(model.searchesAllClients ? "Results for \u{201C}\(model.clientsQuery)\u{201D}"
                                                  : "Loaded clients matching \u{201C}\(model.clientsQuery)\u{201D}. Load more to check the rest.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            ForEach(model.clients) { client in
                Button { if model.allowsWebFallback { opened = client } } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(client.name).font(.headline).foregroundStyle(.primary)
                            Text([client.kindLabel, client.sourceName].compactMap { $0 }.joined(separator: " · "))
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if client.detailPath != nil, model.allowsWebFallback { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary) }
                    }
                }.disabled(client.detailPath == nil || !model.allowsWebFallback)
            }
            if model.nextCursor != nil {
                Button(model.loadingClients ? "Loading…" : "Load more") { Task { await model.loadMoreClients() } }
                    .disabled(model.loadingClients)
            }
        }
        .navigationTitle("Clients")
        .searchable(text: $model.search, prompt: model.searchesAllClients ? "Find a client or organization" : "Filter loaded clients")
        .onSubmit(of: .search) { Task { await model.searchClients() } }
        .onChange(of: model.search) { _, text in if text.isEmpty { Task { await model.searchClients() } } }
        .refreshable { await model.searchClients() }
        .fullScreenCover(item: $opened) { client in WebShellScreen(startPath: client.detailPath) }
        .accessibilityIdentifier("native-clients")
    }
}

private struct NativeMore: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var workspace = false
    @State private var demo = false
    var body: some View {
        Form {
            if let user = model.user {
                Section("Signed in") {
                    LabeledContent("Name", value: user.displayName)
                    LabeledContent("Email", value: user.email)
                    LabeledContent("Role", value: user.profileType)
                }
            }
            if model.allowsWebFallback {
                Section {
                    Button("Open full workspace", systemImage: "macwindow") { workspace = true }
                        .accessibilityIdentifier("native-open-workspace")
                } footer: {
                    Text("Everything from the website, for screens that aren't built into the app yet.")
                }
            }
            Section {
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { Task { await model.signOut() } }
                    .accessibilityIdentifier("native-sign-out")
            } footer: {
                Text("Removes this device's sign-in. You'll need a new code to sign in again.")
            }
            Section { Button("Open demo workspace", systemImage: "testtube.2") { demo = true } }
        }
        .navigationTitle("More")
        .fullScreenCover(isPresented: $workspace) { WebShellScreen() }
        .fullScreenCover(isPresented: $demo) { NativeDemoCover() }
    }
}

private struct NativeDemoCover: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var live = LivePilotModel()
    var body: some View {
        DemoPilotRoot(live: live)
            .safeAreaInset(edge: .top) {
                HStack { Button("Close demo") { dismiss() }; Spacer() }.padding(.horizontal).padding(.vertical, 6).background(.bar)
            }
    }
}

extension OpsWorkspaceClient: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

enum NativeDates {
    /// Server timestamps are ISO 8601; anything else is shown as sent.
    static func short(_ text: String) -> String {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = ISO8601DateFormatter().date(from: text) ?? withFraction.date(from: text) else { return text }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
#endif
