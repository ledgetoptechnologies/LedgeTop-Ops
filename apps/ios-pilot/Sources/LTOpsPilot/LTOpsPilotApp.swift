#if os(iOS)
import SwiftUI
#if SWIFT_PACKAGE
import LTOpsCore
#endif

@main
struct LTOpsPilotApp: App {
    var body: some Scene { WindowGroup { PilotRoot().tint(.teal) } }
}

@MainActor
final class PilotModel: ObservableObject {
    @Published var workspace = OperationsWorkspace()
    @Published var loading = false
    @Published var error: String?
    private let service: any OperationsService
    init(service: any OperationsService = DemoOperationsService()) { self.service = service }
    func reload() async {
        loading = true
        defer { loading = false }
        do {
            workspace = OperationsWorkspace(operations: try await service.loadOperations())
            error = nil
        } catch { self.error = "Could not load the pilot. Please try again." }
    }
    func toggle(_ job: String, _ task: String) { workspace.toggleTask(operationID: job, taskID: task) }
}

struct PilotRoot: View {
    @StateObject private var live = LivePilotModel()
    var body: some View {
        if live.active { LivePilotWorkspace(model: live) }
        else { DemoPilotRoot(live: live) }
    }
}

struct DemoPilotRoot: View {
    @ObservedObject var live: LivePilotModel
    @StateObject private var model = PilotModel()
    var body: some View {
        TabView {
            NavigationStack { TodayView(model: model) }.tabItem { Label("Today", systemImage: "sun.max") }
            NavigationStack { JobsView(model: model) }.tabItem { Label("Operations", systemImage: "square.stack.3d.up") }
            NavigationStack { PilotSettings(model: model, live: live) }.tabItem { Label("Pilot", systemImage: "info.circle") }
        }
        .task { if model.workspace.operations.isEmpty { await model.reload() } }
    }
}

struct DemoNotice: View {
    var body: some View {
        Label("Demo workspace · sample data", systemImage: "testtube.2")
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            .accessibilityIdentifier("demo-notice")
    }
}

struct TodayView: View {
    @ObservedObject var model: PilotModel
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    DemoNotice()
                    Text("Ready for the field.").font(.largeTitle.bold())
                    Text("Review the day's operations, check your tasks, and see what's ready to deliver.").foregroundStyle(.secondary)
                    HStack(alignment: .top, spacing: 28) {
                        metric("Operations", model.workspace.operations.count)
                        metric("Open tasks", model.workspace.openTaskCount)
                    }
                }.padding(.vertical, 8)
            }
            if model.loading { ProgressView("Loading operations") }
            if let error = model.error { Section { Text(error); Button("Try again") { Task { await model.reload() } } } }
            Section("Your operations") {
                ForEach(model.workspace.operations) { job in
                    NavigationLink { OperationDetail(model: model, operationID: job.id) } label: { JobRow(job: job) }
                }
            }
            Section {
                Label("Flight readiness requires your normal operational checks. This pilot does not provide airspace clearance or flight authorization.", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.navigationTitle("LT Ops").refreshable { await model.reload() }
    }
    private func metric(_ title: String, _ value: Int) -> some View {
        VStack(alignment: .leading) { Text(value, format: .number).font(.title.bold()); Text(title).font(.caption).foregroundStyle(.secondary) }
    }
}

struct JobsView: View {
    @ObservedObject var model: PilotModel
    @State private var query = ""
    @State private var status: JobStatus?
    var body: some View {
        List {
            Section {
                DemoNotice()
                Picker("Status", selection: $status) {
                    Text("All operations").tag(Optional<JobStatus>.none)
                    ForEach(JobStatus.allCases, id: \.self) { Text($0.rawValue).tag(Optional($0)) }
                }.accessibilityIdentifier("operation-status-filter")
            }
            let jobs = model.workspace.matching(query, status: status)
            if jobs.isEmpty {
                ContentUnavailableView("No operations found", systemImage: "magnifyingglass", description: Text("Try another search or choose All operations."))
            } else {
                ForEach(jobs) { job in
                    NavigationLink { OperationDetail(model: model, operationID: job.id) } label: { JobRow(job: job) }
                }
            }
        }.navigationTitle("Operations").searchable(text: $query, prompt: "Find a job, client, or service")
    }
}

struct JobRow: View {
    let job: FieldOperation
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(job.status.rawValue.uppercased()).font(.caption2.bold()).foregroundStyle(.teal)
            Text(job.title).font(.headline)
            Text(job.client).font(.subheadline).foregroundStyle(.secondary)
            Label(job.scheduled, systemImage: "clock").font(.caption).foregroundStyle(.secondary)
            ProgressView(value: job.progress).accessibilityLabel("Tasks completed").accessibilityValue("\(job.completedCount) of \(job.tasks.count)")
        }.padding(.vertical, 7)
    }
}

struct OperationDetail: View {
    @ObservedObject var model: PilotModel
    let operationID: String
    var body: some View {
        if let job = model.workspace.operations.first(where: { $0.id == operationID }) {
            List {
                Section { DemoNotice(); Text(job.title).font(.title2.bold()); LabeledContent("Client", value: job.client); LabeledContent("Service", value: job.service); LabeledContent("Site", value: job.location); LabeledContent("Status", value: job.status.rawValue) }
                Section {
                    ForEach(job.tasks) { task in
                        Button { model.toggle(job.id, task.id) } label: {
                            HStack(alignment: .top) {
                                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle").foregroundStyle(task.completed ? .teal : .secondary)
                                Text(task.title).foregroundStyle(.primary)
                                Spacer()
                            }.padding(.vertical, 4)
                        }.accessibilityLabel(task.title).accessibilityValue(task.completed ? "Complete" : "Incomplete")
                            .accessibilityHint("Toggle this demo task. Changes stay in this session.")
                    }
                } header: { Text("Field checklist · \(job.completedCount)/\(job.tasks.count)") } footer: { Text("Checklist changes are local to this demo session and reset when you reload.") }
                Section("Delivery preview") { Label(job.delivery, systemImage: "shippingbox"); Text("Sample description only. No files or sharing links are connected.").font(.footnote).foregroundStyle(.secondary) }
            }.navigationTitle("Operation").navigationBarTitleDisplayMode(.inline)
        } else { ContentUnavailableView("Operation unavailable", systemImage: "folder.badge.questionmark") }
    }
}

struct PilotSettings: View {
    @ObservedObject var model: PilotModel
    @ObservedObject var live: LivePilotModel
    var body: some View {
        Form {
            Section("LT Ops pilot") {
                DemoNotice()
                LabeledContent("Version", value: "0.1.0 pilot")
                LabeledContent("Connection", value: "Offline demo")
                Text("Explore operations, search jobs, and try a field checklist using fictional records.")
            }
            Section("Demo data") {
                Button("Reset demo workspace", systemImage: "arrow.counterclockwise") { Task { await model.reload() } }
                Text("Resets checklist changes. No production accounts, clients, or files are accessed.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Next pilot milestone") {
                Button(live.syntheticProbe ? "Test Cloudflare sign-in" : "Open read-only live workspace") { live.openLive() }
                Text(live.syntheticProbe ? "Test sign-in with a synthetic endpoint; no business data is available yet." : (live.configured ? "Sign in with Cloudflare Access to read permitted operations, clients, and projects." : "Live access is not ready in this pilot build yet."))
            }
        }.navigationTitle("About the pilot")
    }
}
#endif
