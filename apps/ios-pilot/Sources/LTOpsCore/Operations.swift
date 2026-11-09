import Foundation

public enum JobStatus: String, CaseIterable, Sendable {
    case planned = "Planned", inProgress = "In progress", ready = "Ready for delivery"
}

public struct FieldTask: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public var completed: Bool
    public init(id: String, title: String, completed: Bool = false) {
        self.id = id; self.title = title; self.completed = completed
    }
}

public struct FieldOperation: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let client: String
    public let location: String
    public let service: String
    public let status: JobStatus
    public let scheduled: String
    public var tasks: [FieldTask]
    public let delivery: String
    public var completedCount: Int { tasks.filter(\.completed).count }
    public var progress: Double { tasks.isEmpty ? 0 : Double(completedCount) / Double(tasks.count) }
}

/// The synthetic workspace boundary. The separate MobilePilotAPI uses dedicated
/// read-only endpoints and never maps live records into these demo fields.
public protocol OperationsService: Sendable {
    func loadOperations() async throws -> [FieldOperation]
}

public struct DemoOperationsService: OperationsService {
    public init() {}
    public func loadOperations() async throws -> [FieldOperation] { Self.samples }
    public static let samples: [FieldOperation] = [
        FieldOperation(id: "demo-north", title: "North field survey", client: "Demo • Cedar Farm", location: "Training site A", service: "Mapping", status: .inProgress, scheduled: "Demo day · 9:00 AM", tasks: [FieldTask(id: "north-brief", title: "Review site brief", completed: true), FieldTask(id: "north-access", title: "Confirm site access"), FieldTask(id: "north-review", title: "Review captured imagery")], delivery: "Orthomosaic and survey preview"),
        FieldOperation(id: "demo-roof", title: "Roof inspection", client: "Demo • Harbor Works", location: "Training site B", service: "Inspection", status: .planned, scheduled: "Demo day · 1:30 PM", tasks: [FieldTask(id: "roof-brief", title: "Review inspection brief"), FieldTask(id: "roof-contact", title: "Confirm site contact")], delivery: "Inspection images and report"),
        FieldOperation(id: "demo-progress", title: "Construction progress", client: "Demo • Maple Builders", location: "Training site C", service: "Progress capture", status: .ready, scheduled: "Previous demo day", tasks: [FieldTask(id: "progress-capture", title: "Review imagery", completed: true), FieldTask(id: "progress-package", title: "Prepare delivery package", completed: true)], delivery: "12 example photos · sample report")
    ]
}

public struct OperationsWorkspace: Sendable {
    public private(set) var operations: [FieldOperation]
    public init(operations: [FieldOperation] = []) { self.operations = operations }
    public var openTaskCount: Int { operations.flatMap(\.tasks).filter { !$0.completed }.count }
    public func matching(_ query: String, status: JobStatus? = nil) -> [FieldOperation] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return operations.filter { job in
            (status == nil || job.status == status) && (term.isEmpty || [job.title, job.client, job.service, job.location].contains { $0.localizedCaseInsensitiveContains(term) })
        }
    }
    @discardableResult public mutating func toggleTask(operationID: String, taskID: String) -> Bool {
        guard let job = operations.firstIndex(where: { $0.id == operationID }),
              let task = operations[job].tasks.firstIndex(where: { $0.id == taskID }) else { return false }
        operations[job].tasks[task].completed.toggle()
        return true
    }
}
