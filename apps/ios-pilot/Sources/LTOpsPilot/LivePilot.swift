#if os(iOS)
import SwiftUI
import UIKit
import AuthenticationServices
import CryptoKit
import Security
#if SWIFT_PACKAGE
import LTOpsCore
#endif

@MainActor
private final class PilotBrowserLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var generation = UUID()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func open(_ url: URL) async throws -> URL {
        cancel()
        let ticket = generation
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: MobilePilotConfiguration.callbackScheme) { [weak self] url, error in
                Task { @MainActor in
                    guard let self, self.generation == ticket, let continuation = self.continuation else { return }
                    self.continuation = nil
                    self.session = nil
                    if let url { continuation.resume(returning: url) }
                    else { continuation.resume(throwing: error ?? MobilePilotError.signedOut) }
                }
            }
            session.presentationContextProvider = self
            // Use the existing browser SSO session. API requests never share its cookies.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                self.continuation = nil
                continuation.resume(throwing: MobilePilotError.unavailable)
            }
        }
    }
    func cancel() {
        generation = UUID()
        let pending = continuation
        continuation = nil
        session?.cancel()
        session = nil
        pending?.resume(throwing: CancellationError())
    }
}

@MainActor
private enum PilotKeychain {
    static func query(origin: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.ledgetoptechnologies.ops.pilot.readonly",
        kSecAttrAccount as String: origin] }
    static func clear() { for origin in MobilePilotConfiguration.approvedOrigins { SecItemDelete(query(origin: origin) as CFDictionary) } }
    static func save(_ token: MobilePilotToken, origin: String) throws {
        clear()
        var item = query(origin: origin)
        item[kSecValueData as String] = try JSONEncoder().encode(token)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw MobilePilotError.unavailable }
    }
}

@MainActor
final class LivePilotModel: ObservableObject {
    @Published private(set) var active = false
    @Published private(set) var loading = false
    @Published private(set) var user: MobilePilotUser?
    @Published private(set) var collection = MobileOperationCollection()
    @Published private(set) var detail: MobileOperation?
    @Published private(set) var detailLoading = false
    @Published private(set) var message: String?
    @Published private(set) var detailMessage: String?
    private var token: MobilePilotToken?
    private var generation = UUID()
    private var detailGeneration = UUID()
    private var expiry: Task<Void, Never>?
    private let browser = PilotBrowserLogin()
    let configuration: MobilePilotConfiguration?
    private let api: MobilePilotAPI?
    var configured: Bool { configuration != nil }
    var environmentName: String { configuration?.origin.host == "ops.ledgetop.app" ? "Live" : "Staging" }
    var signedIn: Bool { token?.isCurrent == true && user != nil }

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let enabled = info["LTOpsLiveEnabled"] as? Bool == true
        let config = try? MobilePilotConfiguration(enabled: enabled, origin: info["LTOpsOrigin"] as? String ?? "")
        configuration = config
        api = config.map(MobilePilotAPI.init(configuration:))
        // First pilot requires interactive authentication after every process start.
        PilotKeychain.clear()
    }
    func openLive() { active = true }
    func useDemo() { signOut(); active = false }
    func checkExpiry() {
        if let token, !token.isCurrent { signOut(); message = "Your read-only session expired. Sign in again." }
    }
    func signOut() {
        // Revoke the narrow server session when reachable; local clearing never waits.
        if let token, let api { Task { try? await api.revoke(token: token) } }
        generation = UUID()
        detailGeneration = UUID()
        expiry?.cancel(); expiry = nil
        browser.cancel()
        token = nil; user = nil; collection = MobileOperationCollection(); detail = nil
        loading = false; detailLoading = false; message = nil; detailMessage = nil
        PilotKeychain.clear()
    }
    private func randomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw MobilePilotError.unavailable }
        return base64URL(Data(bytes))
    }
    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    func signIn() async {
        guard !loading, let configuration, let api else { return }
        signOut()
        let ticket = generation
        loading = true
        var issuedSession: MobilePilotToken?
        defer {
            if generation == ticket { loading = false }
            // A cancelled login can finish issuing a session after local sign-out.
            if let issuedSession, token?.accessToken != issuedSession.accessToken {
                Task { try? await api.revoke(token: issuedSession) }
            }
        }
        do {
            let verifier = try randomValue(), state = try randomValue()
            let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
            let callback = try await browser.open(configuration.authorizeURL(state: state, challenge: challenge))
            guard generation == ticket else { return }
            let code = try MobilePilotConfiguration.callbackCode(callback, expectedState: state)
            let issued = try await api.redeem(code: code, verifier: verifier, state: state)
            issuedSession = issued
            guard generation == ticket else { return }
            let identity = try await api.identity(token: issued)
            guard generation == ticket else { return }
            try PilotKeychain.save(issued, origin: configuration.origin.absoluteString)
            token = issued; user = identity.user
            let remaining = max(0, Double(issued.expiresAt) - Date().timeIntervalSince1970)
            expiry = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
                guard let self, self.generation == ticket else { return }
                self.signOut(); self.message = "Your read-only session expired. Sign in again."
            }
            let page = try await api.operations(token: issued)
            guard generation == ticket, issued.isCurrent else { return }
            try collection.append(page, requestedCursor: nil)
        } catch {
            guard generation == ticket else { return }
            signOut()
            if !(error is CancellationError) { message = Self.explanation(error) }
        }
    }
    func refresh() async { await load(reset: true) }
    func loadMore() async { await load(reset: false) }
    private func load(reset: Bool) async {
        guard !loading, let token, let api else { return }
        guard token.isCurrent else { signOut(); message = "Your read-only session expired. Sign in again."; return }
        let ticket = generation
        let cursor = reset ? nil : collection.nextCursor
        if !reset && cursor == nil { return }
        loading = true; message = nil
        // Remove old rows on a refresh failure instead of silently showing revoked data.
        if reset { collection = MobileOperationCollection(); detail = nil; detailGeneration = UUID() }
        defer { if generation == ticket { loading = false } }
        do {
            _ = try await api.identity(token: token)
            let page = try await api.operations(token: token, cursor: cursor)
            guard generation == ticket, token.isCurrent else { return }
            try collection.append(page, requestedCursor: cursor)
        } catch {
            guard generation == ticket else { return }
            signOut(); message = Self.explanation(error)
        }
    }
    func showDetail(id: String) async {
        guard let token, let api else { return }
        detail = nil; detailMessage = nil; detailLoading = true
        detailGeneration = UUID()
        let ticket = generation, detailTicket = detailGeneration
        defer { if generation == ticket && detailGeneration == detailTicket { detailLoading = false } }
        do {
            let result = try await api.operation(token: token, id: id)
            guard generation == ticket, detailGeneration == detailTicket, token.isCurrent else { return }
            detail = result
        } catch {
            guard generation == ticket, detailGeneration == detailTicket else { return }
            if let failure = error as? MobilePilotError, [.signedOut, .denied, .expired].contains(failure) {
                signOut(); message = Self.explanation(error)
            } else { detailMessage = Self.explanation(error) }
        }
    }
    private static func explanation(_ error: Error) -> String {
        if let browserError = error as? ASWebAuthenticationSessionError, browserError.code == .canceledLogin { return "Sign-in cancelled." }
        switch error as? MobilePilotError {
        case .signedOut, .expired: return "Your read-only session ended. Sign in again."
        case .denied: return "Your account does not currently have access to this pilot or operation."
        case .notFound: return "This operation is no longer available to your account."
        case .unavailable: return "Live access is not ready in this pilot build yet."
        case .invalidCallback: return "Sign-in could not be verified. Please start again."
        default: return "Could not load live data. Check your connection and sign in again."
        }
    }
}

struct LivePilotWorkspace: View {
    @ObservedObject var model: LivePilotModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var query = ""
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("\(model.environmentName) workspace · read only", systemImage: "lock.shield").font(.caption.bold())
                    if let user = model.user { Text(user.displayName); Text(user.email).font(.caption).foregroundStyle(.secondary) }
                    Text("\(model.collection.operations.count) operations loaded").font(.headline)
                    Text("Counts and search cover loaded records only.").font(.caption).foregroundStyle(.secondary)
                }
                if let message = model.message { Section { Text(message) } }
                if model.loading { ProgressView("Loading live operations") }
                if model.signedIn {
                    let matches = model.collection.operations.filter { query.isEmpty || [$0.title, $0.projectName ?? "", $0.location ?? "", $0.status].contains { $0.localizedCaseInsensitiveContains(query) } }
                    Section("Operations") {
                        if matches.isEmpty && !model.loading { Text("No matching operations in the loaded records.").foregroundStyle(.secondary) }
                        ForEach(matches) { operation in
                            NavigationLink { LiveOperationDetail(model: model, id: operation.id) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(operation.title).font(.headline)
                                    Text(operation.status).font(.caption).foregroundStyle(.teal)
                                    if let name = operation.projectName { Text(name).font(.subheadline).foregroundStyle(.secondary) }
                                }
                            }
                        }
                        if model.collection.nextCursor != nil { Button("Load more operations") { Task { await model.loadMore() } }.disabled(model.loading) }
                    }
                    Section { Button("Sign out", role: .destructive) { model.signOut() }; Text("Signing out removes this app's session and loaded data. Your browser sign-in is separate.").font(.caption) }
                } else {
                    Section {
                        if model.configured {
                            Button("Sign in with Cloudflare Access") { Task { await model.signIn() } }.disabled(model.loading)
                            Text("Uses your existing LT Ops staff sign-in. The pilot can only read permitted operations; sessions last up to 15 minutes.").font(.footnote)
                        } else {
                            Text("Live access is not ready in this pilot build yet.")
                        }
                    }
                }
                Section { Button("Return to demo workspace") { model.useDemo() } }
            }
            .navigationTitle("LT Ops · \(model.environmentName)")
            .searchable(text: $query, prompt: "Search loaded operations")
            .refreshable { await model.refresh() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { model.checkExpiry() } }
        }
    }
}

struct LiveOperationDetail: View {
    @ObservedObject var model: LivePilotModel
    let id: String
    var body: some View {
        List {
            Section { Label("\(model.environmentName) operation · read only", systemImage: "lock.shield").font(.caption.bold()) }
            if model.detailLoading { ProgressView("Loading operation") }
            if let message = model.detailMessage { Text(message); Button("Try again") { Task { await model.showDetail(id: id) } } }
            if let operation = model.detail, operation.id == id {
                Section {
                    Text(operation.title).font(.title2.bold())
                    LabeledContent("Status", value: operation.status)
                    if let value = operation.projectName { LabeledContent("Project", value: value) }
                    if let value = operation.divisionName { LabeledContent("Division", value: value) }
                    if let value = operation.location { LabeledContent("Location", value: value) }
                    if let value = operation.scheduledStart { LabeledContent("Scheduled start", value: localSchedule(value)) }
                    if let value = operation.scheduledEnd { LabeledContent("Scheduled end", value: localSchedule(value)) }
                }
                Section { Text("This first live pilot shows operation summaries only. Checklists, files, delivery controls, and edits are not available.").font(.footnote).foregroundStyle(.secondary) }
            }
        }.navigationTitle("Operation").task(id: id) { await model.showDetail(id: id) }
    }
    private func localSchedule(_ value: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = parser.date(from: value)
        if date == nil {
            parser.formatOptions = [.withInternetDateTime]
            date = parser.date(from: value)
        }
        // Preserve unrecognized source values rather than guessing a timezone or date.
        guard let date else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
#endif
