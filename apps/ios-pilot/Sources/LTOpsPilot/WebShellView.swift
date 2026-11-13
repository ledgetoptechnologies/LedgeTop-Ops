#if os(iOS)
import SwiftUI
import WebKit
import os
#if SWIFT_PACKAGE
import LTOpsCore

/// Test hook: launching with `-LTOpsOpenWebShell YES` opens the workspace without a tap,
/// in builds that turn the web workspace on.
struct WebShellLaunchHook: ViewModifier {
    @State private var open = false
    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $open) { WebShellScreen() }
            .onAppear {
                if UserDefaults.standard.bool(forKey: "LTOpsOpenWebShell"),
                   WebShellConfiguration.isEnabled(Bundle.main.infoDictionary) { open = true }
            }
    }
}
#endif

// Hybrid shell: the app hosts the shared web UI in a web view and keeps
// sign-in, downloads and offline storage native. Off unless the build sets
// LTOpsWebShellEnabled and an exact-origin allowlist in Info.plist.

/// Keeps the web view's content controller from retaining the model.
private final class WebShellMessageProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WebShellModel?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let isMainFrame = message.frameInfo.isMainFrame
        let origin = message.frameInfo.securityOrigin
        let frameURL = URL(string: "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")/")
        guard let target else { replyHandler(nil, "unavailable"); return }
        replyHandler(target.receipt(for: message.body, isMainFrame: isMainFrame, frameURL: frameURL), nil)
    }
}

@MainActor
final class WebShellModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    enum Phase: String, Equatable { case loading, ready, signInRequired, blocked, failed }
    @Published private(set) var phase: Phase = .loading {
        didSet { if phase != oldValue { note("phase \(phase.rawValue)") } }
    }
    /// True while the pinned sign-in page, not the workspace, is on screen.
    @Published private(set) var showingSignIn = false
    private static let log = Logger(subsystem: "com.ledgetoptechnologies.ops.pilot", category: "webshell")
    /// State lines for unattended device tests. Hosts and paths only; never queries, tokens or page text.
    private func note(_ text: String) { WebShellModel.log.notice("webshell \(text, privacy: .public)") }
    @Published private(set) var canGoBack = false

    let configuration: WebShellConfiguration
    private let policy: WebShellNavigationPolicy
    private var limiter = WebShellRateLimiter()
    private let proxy = WebShellMessageProxy()
    private(set) lazy var webView: WKWebView = makeWebView()

    init(configuration: WebShellConfiguration) {
        self.configuration = configuration
        policy = WebShellNavigationPolicy(configuration: configuration)
        super.init()
        proxy.target = self
    }

    private func makeWebView() -> WKWebView {
        let setup = WKWebViewConfiguration()
        // Without the in-app sign-in option nothing from the web session is kept on the device.
        // With it, the sign-in cookie stays in the app's own web data until "Sign out".
        setup.websiteDataStore = configuration.signInHost == nil ? .nonPersistent() : .default()
        setup.preferences.javaScriptCanOpenWindowsAutomatically = false
        setup.allowsInlineMediaPlayback = true
        setup.userContentController.addUserScript(WKUserScript(
            source: WebShellBridge.bootstrapScript(capabilities: WebShellBridge.supportedCapabilities, origins: configuration.origins),
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        setup.userContentController.addScriptMessageHandler(proxy, contentWorld: .page, name: WebShellBridge.handlerName)
        let view = WKWebView(frame: .zero, configuration: setup)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsLinkPreview = false
        #if DEBUG
        view.isInspectable = true
        #else
        view.isInspectable = false
        #endif
        return view
    }

    func start() {
        guard webView.url == nil else { return }
        reload()
    }

    func reload() {
        phase = .loading
        webView.load(URLRequest(url: configuration.start, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func goBack() { if webView.canGoBack { webView.goBack() } }

    var canSignOut: Bool { configuration.signInHost != nil }

    /// Removes every cookie and stored web record for the workspace, then starts over.
    func signOut() async {
        let store = webView.configuration.websiteDataStore
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        note("signed out")
        reload()
    }

    /// Bridge requests are honored only from an allowlisted main frame.
    fileprivate func receipt(for body: Any, isMainFrame: Bool, frameURL: URL?) -> [String: any Sendable] {
        guard isMainFrame, let frameURL, configuration.allows(frameURL) else {
            return WebShellReceipt.failure(WebShellBridge.requestId(of: body), .denied).json
        }
        return WebShellBridge.respond(to: body, capabilities: WebShellBridge.supportedCapabilities, limiter: &limiter).json
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        let isMainFrame = action.targetFrame?.isMainFrame ?? true
        switch policy.decide(url: action.request.url, isMainFrame: isMainFrame,
                             userInitiated: action.navigationType == .linkActivated) {
        case .allow:
            if action.shouldPerformDownload { return .cancel }
            if isMainFrame, let url = action.request.url, url.scheme == "https" {
                note("navigate \(url.host ?? "")\(url.path)")
            }
            return .allow
        case .external(let url):
            note("external \(url.host ?? url.scheme ?? "")")
            await UIApplication.shared.open(url)
            return .cancel
        case .nativeSignIn:
            note("blocked sign-in page \(action.request.url?.host ?? "")")
            phase = .signInRequired
            return .cancel
        case .cancel:
            if isMainFrame, let url = action.request.url, url.scheme == "https" {
                note("dropped \(url.host ?? "")\(url.path)")
                // A redirect to an address outside the allowlist would otherwise leave the spinner up forever.
                if phase == .loading { phase = .blocked }
            }
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        guard response.canShowMIMEType else { return .cancel }
        if response.isForMainFrame, let url = response.response.url, url.absoluteString != "about:blank",
           !configuration.allowsDocument(url) { return .cancel }
        return .allow
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if phase != .signInRequired, phase != .blocked { phase = .loading }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        canGoBack = webView.canGoBack
        showingSignIn = webView.url.map { !configuration.allows($0) } ?? false
        note("finished \(webView.url?.host ?? "")\(webView.url?.path ?? "") signIn=\(showingSignIn)")
        if phase != .signInRequired, phase != .blocked { phase = .ready }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }

    private func failed(_ error: Error) {
        let code = (error as NSError).code
        // A cancelled or policy-interrupted load is not a failure to report.
        if code == NSURLErrorCancelled || code == 102 {
            if phase == .loading, webView.url != nil { phase = .ready }
            return
        }
        note("failed code \(code)")
        if phase != .signInRequired, phase != .blocked { phase = .failed }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() }

    // Links that ask for a new window load in place when allowed; no extra windows.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, self.configuration.allows(url) { webView.load(action.request) }
        return nil
    }
}

private struct WebShellContainer: UIViewRepresentable {
    let model: WebShellModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

private struct WebShellWorkspace: View {
    @StateObject private var model: WebShellModel
    let close: () -> Void
    init(configuration: WebShellConfiguration, close: @escaping () -> Void) {
        _model = StateObject(wrappedValue: WebShellModel(configuration: configuration))
        self.close = close
    }
    var body: some View {
        ZStack {
            WebShellContainer(model: model).ignoresSafeArea(edges: .bottom)
                .opacity(model.phase == .ready || model.phase == .loading ? 1 : 0)
                .accessibilityIdentifier("web-shell-view")
            switch model.phase {
            case .loading: ProgressView("Loading workspace")
            case .ready: EmptyView()
            case .signInRequired:
                ContentUnavailableView {
                    Label("Sign-in needed", systemImage: "person.badge.key")
                } description: {
                    Text("The workspace asked you to sign in. This build can't complete sign-in for the web workspace yet, so nothing was loaded.")
                } actions: {
                    Button("Try again") { model.reload() }
                    Button("Close", action: close)
                }.accessibilityIdentifier("web-shell-sign-in")
            case .blocked:
                ContentUnavailableView {
                    Label("Address not approved", systemImage: "hand.raised")
                } description: {
                    Text("The workspace tried to move to an address this build doesn't allow, so it was stopped.")
                } actions: {
                    Button("Try again") { model.reload() }
                    Button("Close", action: close)
                }.accessibilityIdentifier("web-shell-blocked")
            case .failed:
                ContentUnavailableView {
                    Label("Couldn't load the workspace", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("Check your connection, then try again.")
                } actions: {
                    Button("Try again") { model.reload() }
                    Button("Close", action: close)
                }.accessibilityIdentifier("web-shell-failed")
            }
        }
        .navigationTitle(model.showingSignIn ? "Sign in" : "Workspace").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button("Close", action: close).accessibilityIdentifier("web-shell-close") }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Back", systemImage: "chevron.backward") { model.goBack() }.disabled(!model.canGoBack)
                Button("Reload", systemImage: "arrow.clockwise") { model.reload() }
                if model.canSignOut {
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") { Task { await model.signOut() } }
                        .accessibilityIdentifier("web-shell-sign-out")
                }
            }
        }
        .task { model.start() }
    }
}

/// Entry point for the hosted web workspace.
struct WebShellScreen: View {
    @Environment(\.dismiss) private var dismiss
    private let configuration = WebShellConfiguration.fromInfo(Bundle.main.infoDictionary)
    var body: some View {
        NavigationStack {
            if let configuration {
                WebShellWorkspace(configuration: configuration) { dismiss() }
            } else {
                ContentUnavailableView {
                    Label("Workspace isn't set up", systemImage: "rectangle.dashed")
                } description: {
                    Text("This build has no approved workspace address, so nothing was loaded.")
                } actions: {
                    Button("Close") { dismiss() }
                }.accessibilityIdentifier("web-shell-unconfigured")
            }
        }
    }
}

/// Settings row shown only in builds that turn the web workspace on.
struct WebShellEntry: View {
    @State private var open = false
    var body: some View {
        if WebShellConfiguration.isEnabled(Bundle.main.infoDictionary) {
            Section("Web workspace") {
                Button("Open web workspace", systemImage: "macwindow") { open = true }
                    .accessibilityIdentifier("web-shell-open")
                Text("Shows the same screens as the website inside the app. Downloads and offline files are not connected yet.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .fullScreenCover(isPresented: $open) { WebShellScreen() }
        }
    }
}
#endif
