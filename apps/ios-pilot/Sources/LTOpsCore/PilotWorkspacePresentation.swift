import Foundation

/// The tabs of the native workspace and the rules for which ones a mode shows.
public enum PilotWorkspaceTab: String, CaseIterable, Sendable {
    case home, operations, tasks, clients, more
}

public enum PilotWorkspacePresentation {
    /// The tabs to show. The staff web session shows everything. A read-only source shows only the
    /// areas it provides: an area it reports as not offered (or has not answered for yet) gets no tab,
    /// so the pilot never shows an empty screen where data was never going to appear.
    public static func tabs(readOnly: Bool, dashboard: OpsWorkspaceFreshness, tasks: OpsWorkspaceFreshness) -> [PilotWorkspaceTab] {
        guard readOnly else { return PilotWorkspaceTab.allCases }
        func offered(_ freshness: OpsWorkspaceFreshness) -> Bool { freshness != .notOffered && freshness != .idle }
        return PilotWorkspaceTab.allCases.filter { tab in
            switch tab {
            case .home: return offered(dashboard)
            case .tasks: return offered(tasks)
            case .operations, .clients, .more: return true
            }
        }
    }

    /// Where the app opens. An explicit request wins when it names a real tab; otherwise the read-only
    /// pilot opens on Clients (the data it has) and the staff session on Home.
    public static func landing(requested: String?, readOnly: Bool) -> PilotWorkspaceTab {
        if let requested, let tab = PilotWorkspaceTab(rawValue: requested) { return tab }
        return readOnly ? .clients : .home
    }

    /// The tab to select given what is available: the current one if it is shown, otherwise the mode's landing tab.
    public static func resolve(selected: PilotWorkspaceTab, available: [PilotWorkspaceTab], readOnly: Bool) -> PilotWorkspaceTab {
        if available.contains(selected) { return selected }
        let fallback = landing(requested: nil, readOnly: readOnly)
        return available.contains(fallback) ? fallback : (available.first ?? .more)
    }

    /// A readable name for a source the app knows exactly. Unknown ids are returned unchanged, never guessed.
    public static func sourceLabel(_ id: String?) -> String? {
        guard let id, !id.isEmpty else { return nil }
        switch id {
        case "project-alpha:staging": return "Staging workspace"
        case "project-alpha:source-2-staging": return "Staging workspace 2"
        default: return id
        }
    }

    /// The marker shown on every screen of the read-only pilot, e.g. "Read-only pilot · Staging data".
    public static func readOnlyMarker(environment: String) -> String {
        let name = environment.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Read-only pilot" : "Read-only pilot · \(name) data"
    }
}
