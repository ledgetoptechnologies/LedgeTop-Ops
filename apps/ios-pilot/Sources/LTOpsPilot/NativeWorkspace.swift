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
    enum State: Equatable { case checking, signedOut, ready, forbidden, unavailable }
    @Published private(set) var state: State = .checking
    @Published private(set) var user: OpsWorkspaceUser?
    @Published private(set) var dashboard: OpsWorkspaceDashboard?
    @Published private(set) var operations: [OpsWorkspaceFieldOperation]?
    @Published private(set) var clients: [OpsWorkspaceClient] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var loadingClients = false
    @Published private(set) var clientsError: String?
    @Published var search = ""

    let configuration: WebShellConfiguration
    private let api: OpsWorkspaceAPI
    private var generation = 0
    private static let log = Logger(subsystem: "com.ledgetoptechnologies.ops.pilot", category: "native")
    private func note(_ text: String) { NativeWorkspaceModel.log.notice("native \(text, privacy: .public)") }

    init?(configuration: WebShellConfiguration) {
        guard let origin = WebShellOrigin(url: configuration.start) else { return nil }
        self.configuration = configuration
        api = OpsWorkspaceAPI(origin: origin, cookies: { await NativeWorkspaceModel.cookieHeader(for: origin) })
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

    func refresh() async {
        generation += 1
        let ticket = generation
        if user == nil { state = .checking }
        do {
            let user = try await api.session()
            guard ticket == generation else { return }
            self.user = user
            state = .ready
            note("state ready profile=\(user.profileType)")
            async let board = api.dashboard()
            async let page = api.clients(search: search)
            async let list = api.operations()
            let dashboard = try? await board
            let clients = try? await page
            let operations = try? await list
            guard ticket == generation else { return }
            self.dashboard = dashboard
            self.operations = operations
            if let clients {
                self.clients = clients.clients
                nextCursor = clients.nextCursor
                clientsError = nil
            } else { clientsError = "Clients couldn't be loaded." }
            note("loaded dashboard=\(dashboard != nil) operations=\(operations?.count ?? -1) tasks=\(dashboard?.tasks.count ?? -1) clients=\(clients?.clients.count ?? -1)")
        } catch {
            guard ticket == generation else { return }
            apply(error)
        }
    }

    func searchClients() async {
        let ticket = generation
        loadingClients = true
        defer { loadingClients = false }
        do {
            let page = try await api.clients(search: search)
            guard ticket == generation else { return }
            clients = page.clients
            nextCursor = page.nextCursor
            clientsError = nil
        } catch {
            guard ticket == generation else { return }
            if (error as? OpsWorkspaceError) == .signedOut { apply(error) } else { clientsError = "Clients couldn't be loaded." }
        }
    }

    func loadMoreClients() async {
        guard let cursor = nextCursor, !loadingClients else { return }
        let ticket = generation
        loadingClients = true
        defer { loadingClients = false }
        do {
            let page = try await api.clients(search: search, cursor: cursor)
            guard ticket == generation else { return }
            let known = Set(clients.map(\.id))
            clients += page.clients.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            guard ticket == generation else { return }
            if (error as? OpsWorkspaceError) == .signedOut { apply(error) } else { clientsError = "More clients couldn't be loaded." }
        }
    }

    /// Removes the web session and every stored web record, then shows the sign-in screen.
    func signOut() async {
        generation += 1
        await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        clearData()
        state = .signedOut
        note("state signedOut (user)")
    }

    private func apply(_ error: Error) {
        switch error as? OpsWorkspaceError {
        case .signedOut?: clearData(); state = .signedOut
        case .forbidden?: clearData(); state = .forbidden
        default: state = user == nil ? .unavailable : .ready
        }
        note("state \(String(describing: state))")
    }

    private func clearData() {
        user = nil
        dashboard = nil
        operations = nil
        clients = []
        nextCursor = nil
        clientsError = nil
    }
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
            } else {
                Section { Text("The dashboard couldn't be loaded. Pull down to try again.").foregroundStyle(.secondary) }
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
            } else {
                Section { Text("Operations couldn't be loaded. Pull down to try again.").foregroundStyle(.secondary) }
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

private struct NativeClients: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var opened: OpsWorkspaceClient?
    var body: some View {
        List {
            if let error = model.clientsError {
                Section { Label(error, systemImage: "exclamationmark.triangle"); Button("Try again") { Task { await model.searchClients() } } }
            }
            if model.clients.isEmpty, model.clientsError == nil, !model.loadingClients {
                ContentUnavailableView(model.search.isEmpty ? "No clients yet" : "No clients found", systemImage: "person.2",
                                       description: Text(model.search.isEmpty ? "Clients you can see will appear here." : "Try another name."))
            }
            ForEach(model.clients) { client in
                Button { opened = client } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(client.name).font(.headline).foregroundStyle(.primary)
                            Text([client.kindLabel, client.sourceName].compactMap { $0 }.joined(separator: " · "))
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if client.detailPath != nil { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary) }
                    }
                }.disabled(client.detailPath == nil)
            }
            if model.nextCursor != nil {
                Button(model.loadingClients ? "Loading…" : "Load more") { Task { await model.loadMoreClients() } }
                    .disabled(model.loadingClients)
            }
        }
        .navigationTitle("Clients")
        .searchable(text: $model.search, prompt: "Find a client or organization")
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
            Section {
                Button("Open full workspace", systemImage: "macwindow") { workspace = true }
                    .accessibilityIdentifier("native-open-workspace")
            } footer: {
                Text("Everything from the website, for screens that aren't built into the app yet.")
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
