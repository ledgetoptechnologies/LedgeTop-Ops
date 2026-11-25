import Foundation

/// Which experience a build opens. The two connected modes never substitute for each other:
/// a build that asks for the scoped read-only mode can never end up on the staff web session.
public enum PilotWorkspaceMode: Equatable, Sendable {
    /// The offline demo and the pilot's existing sign-in test screens.
    case demo
    /// Native screens on the scoped read-only data source.
    case scoped
    /// Native screens on the person's ordinary staff web session, with the website as a fallback.
    case staffWeb
    /// The build asks for both connected modes at once. Nothing connected is opened.
    case conflicting

    /// - Parameters:
    ///   - liveEnabled: the build sets `LTOpsLiveEnabled` (scoped mode requested).
    ///   - scopedSourceAvailable: a reviewed scoped source exists for this build's pins.
    ///   - webShellEnabled: the build sets `LTOpsWebShellEnabled` (staff web mode requested).
    ///   - webShellConfigured: the staff web allowlist is present and valid.
    public static func select(liveEnabled: Bool, scopedSourceAvailable: Bool,
                              webShellEnabled: Bool, webShellConfigured: Bool) -> PilotWorkspaceMode {
        if liveEnabled && webShellEnabled { return .conflicting }
        // A requested scoped mode that is not available falls back to the demo, never to staff cookies.
        if liveEnabled { return scopedSourceAvailable ? .scoped : .demo }
        if webShellEnabled { return webShellConfigured ? .staffWeb : .demo }
        return .demo
    }
}
