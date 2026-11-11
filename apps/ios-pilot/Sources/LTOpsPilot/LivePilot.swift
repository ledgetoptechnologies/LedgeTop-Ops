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
}

/// Activation requires a reviewed source change to add one exact pilot resource
/// and the provider endpoint pins. An Info.plist toggle alone cannot enable it.
private enum ManagedPilotBuildConfiguration {
    // Both modes use the dedicated staging Access resource and pinned OAuth
    // endpoints. Business reads remain disabled in Info.plist until the private
    // reader is deployed and its provider-backed acceptance checks pass.
    static let approvedPins: [ManagedOAuthPins] = [try? ManagedOAuthPins(
        resource: "https://ios-pilot-staging.ledgetop.app",
        issuer: "https://ledgetoptechnologies.cloudflareaccess.com",
        authorizationEndpoint: "https://ledgetoptechnologies.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
        tokenEndpoint: "https://ledgetoptechnologies.cloudflareaccess.com/cdn-cgi/access/oauth/token",
        registrationEndpoint: "https://ledgetoptechnologies.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
        revocationEndpoint: "https://ledgetoptechnologies.cloudflareaccess.com/cdn-cgi/access/oauth/revoke"
    )].compactMap { $0 }
    // The current staging resource's synthetic endpoint stays available for
    // sign-in diagnostics without enabling business data reads.
    static let approvedProbePins = approvedPins
    static func selected(live: Bool, probe: Bool) -> (ManagedOAuthPins, Bool)? {
        guard live != probe else { return nil }
        let pins = probe ? approvedProbePins : approvedPins
        guard pins.count == 1, let selected = pins.first else { return nil }
        return (selected, probe)
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
    @Published private(set) var businessRoots = MobileBusinessRoots()
    @Published private(set) var businessProjects = MobileBusinessProjects()
    @Published private(set) var selectedBusinessRoot: MobileBusinessRoot?
    @Published private(set) var businessRootsLoaded = false
    @Published private(set) var businessLoading = false
    @Published private(set) var businessMessage: String?
    @Published private(set) var probeSucceeded = false
    @Published private(set) var probeContext: SyntheticAccessContext?
    private var generation = UUID()
    private var detailGeneration = UUID()
    private var businessGeneration = UUID()
    private var expiry: Task<Void, Never>?
    private var signOutTask: Task<ManagedOAuthSignOutReport, Never>?
    private var savedTestCleanup: Task<SyntheticAccessSignOut, Never>?
    private var restartSaveTask: Task<Void, Error>?
    private var restartTest: SyntheticAccessRestore?
    private var liveRestart: ManagedAccessOnlyRestore?
    private var liveRemovalUnconfirmed = false
    private var pendingRequests: [UUID: @Sendable () -> Void] = [:]
    private let browser = PilotBrowserLogin()
    private var credential: ManagedOAuthCredential?
    private var coordinator: ManagedOAuthCoordinator?
    private var api: ManagedPilotDataAPI?
    private var isSyntheticProbe = false
    var configured: Bool { coordinator != nil && api != nil }
    var syntheticProbe: Bool { isSyntheticProbe }
    var businessEnabled: Bool { !isSyntheticProbe && api != nil && Bundle.main.infoDictionary?["LTOpsBusinessPilotEnabled"] as? Bool == true }
    var environmentName: String { isSyntheticProbe ? "Sign-in test" : "Staging" }
    var signedIn: Bool { credential.map { $0.expiresAt > Date() } == true && (user != nil || probeSucceeded) }

    init() {
        let enabled = Bundle.main.infoDictionary?["LTOpsLiveEnabled"] as? Bool == true
        let probe = Bundle.main.infoDictionary?["LTOpsSyntheticProbeEnabled"] as? Bool == true
        if let (pins, synthetic) = ManagedPilotBuildConfiguration.selected(live: enabled, probe: probe) {
            isSyntheticProbe = synthetic
            let browser = self.browser
            coordinator = ManagedOAuthCoordinator(pins: pins, transport: ManagedOAuthTransport(pins: pins),
                browser: { url in try await browser.open(url) }, proofFactory: { try ManagedOAuthProofGenerator.generate() })
            api = ManagedPilotDataAPI(pins: pins)
            if synthetic, let api {
                let transport = ManagedOAuthTransport(pins: pins)
                restartTest = try? SyntheticAccessRestore(pins: pins, store: SyntheticAccessKeychainStore(),
                    verify: { credential in _ = try await api.verifySyntheticProbe(credential: credential) },
                    revoke: { token, client in try await transport.revoke(token: token, clientID: client, hint: .access) })
            } else if !synthetic, let api {
                liveRestart = ManagedAccessOnlyRestore(pins: pins, store: ManagedAccessOnlyKeychainStore(pins: pins),
                    verify: { credential in try await api.identity(credential: credential) })
            }
        }
        // Remove tokens from older pilot builds; managed credentials stay in memory.
        PilotKeychain.clear()
    }
    func openLive() {
        active = true
        if !isSyntheticProbe, !signedIn, !loading, liveRestart != nil {
            Task { await restoreLiveSession() }
        }
        guard isSyntheticProbe, let cleanup = savedTestCleanup else { return }
        let ticket = generation
        Task { [weak self] in
            let result = await cleanup.value
            guard let self, self.generation == ticket, result == .localRemovalUnconfirmed else { return }
            self.message = "Could not confirm removal of the saved test on this iPad. Unlock it and try Clear saved test again."
        }
    }
    func useDemo() { signOut(); active = false }
    func restoreLiveSession() async {
        guard !isSyntheticProbe, !loading, !signedIn, let coordinator, let api, let liveRestart else { return }
        let ticket = generation
        loading = true; message = nil
        defer { if generation == ticket { loading = false } }
        do {
            guard let restored = try await perform({ try await coordinator.restoreReadOnlySession(from: liveRestart) }) else {
                message = "No saved read-only session is available. Sign in with Cloudflare Access."
                return
            }
            guard generation == ticket else { return }
            let page = try await perform { try await api.operations(credential: restored.credential) }
            guard generation == ticket, restored.credential.expiresAt > Date() else { return }
            var restoredCollection = MobileOperationCollection()
            try restoredCollection.append(page, requestedCursor: nil)
            credential = restored.credential; user = restored.session.user; collection = restoredCollection
            scheduleReadExpiry(restored.credential, ticket: ticket)
            message = "Your saved session was checked online. Operations data was refreshed from the server."
        } catch {
            guard generation == ticket else { return }
            message = "The saved session could not be verified online. Connect to the internet and retry, or sign in again. No saved Operations data is shown."
        }
    }
    func saveRestartTest() async {
        guard isSyntheticProbe, signedIn, !loading, let coordinator, let restartTest else { return }
        let ticket = generation
        loading = true; defer { if generation == ticket { loading = false } }
        let save = Task { try await coordinator.saveSyntheticRestartTest(to: restartTest) }
        restartSaveTask = save
        defer { restartSaveTask = nil }
        do {
            try await save.value
            guard generation == ticket else { return }
            message = "Test access saved on this iPad for up to 15 minutes. Close or restart the app, open Test Cloudflare sign-in and choose Restore saved test before signing in. The Cloudflare refresh grant is not stored and its revocation after a restart cannot be confirmed."
        } catch {
            guard generation == ticket else { return }
            message = "The test could not be saved. Local removal may need to be retried using Clear saved test."
        }
    }
    func restoreRestartTest() async {
        guard isSyntheticProbe, !signedIn, !loading, let restartTest else { return }
        let ticket = generation
        loading = true; defer { if generation == ticket { loading = false } }
        if let cleanup = savedTestCleanup, await cleanup.value == .localRemovalUnconfirmed {
            guard generation == ticket else { return }
            message = "Could not confirm removal of the saved test on this iPad. Unlock it and try Clear saved test again."
            return
        }
        guard generation == ticket else { return }
        do {
            if let value = try await restartTest.restore(), value.expiresAt > Date() {
                guard generation == ticket else { return }
                message = "Saved test access was verified online. This is a restart test, not a restored business-data session. Use Clear saved test to remove it."
            } else { message = "No saved test is available. Sign in and save a test first." }
        } catch {
            guard generation == ticket else { return }
            message = "Saved test access could not be verified. Unlock the iPad, check the connection, or clear the saved test and sign in again."
        }
    }
    func clearRestartTest() {
        guard isSyntheticProbe, let restartTest else { return }
        let ticket = generation
        let previous = savedTestCleanup
        let task = Task { () -> SyntheticAccessSignOut in
            _ = await previous?.value
            return await restartTest.signOut()
        }
        savedTestCleanup = task
        Task { [weak self] in
            let result = await task.value
            guard let self, self.generation == ticket else { return }
            switch result {
            case .noLocalCredential: self.message = "No saved test was found."
            case .localRemovalUnconfirmed: self.message = "Could not confirm removal of the saved test on this iPad. Unlock it and try Clear saved test again."
            case .remoteRevocationUnconfirmed: self.message = "Saved test removed from this iPad. Cloudflare grant revocation cannot be confirmed."
            }
        }
    }
    func testSyntheticRefreshReplay() {
        guard isSyntheticProbe, signedIn, !loading, let coordinator else { return }
        generation = UUID()
        let ticket = generation
        expiry?.cancel(); expiry = nil
        credential = nil; probeSucceeded = false; probeContext = nil; loading = true; message = nil
        Task { [weak self] in
            let report = await coordinator.runSyntheticRefreshExperiment()
            // If the experiment could not take ownership, clear any old grant.
            _ = await coordinator.signOutReport()
            let cleanup = await self?.restartTest?.signOut()
            guard let self, self.generation == ticket else { return }
            self.loading = false
            let finding: String
            switch report.observation {
            case .rotatedReplayRejectedCurrentRejected:
                finding = "Refresh tokens changed. A reused token and the latest token both received HTTP 400."
            case .rotatedReplayRejectedCurrentAccepted:
                finding = "Refresh tokens changed. A reused token received HTTP 400, but the latest token was accepted."
            case .replayAccepted: finding = "A reused refresh token was accepted."
            case .notRotated: finding = "A refresh token did not change."
            case .inconclusive: finding = "The refresh test was inconclusive."
            }
            if cleanup == .localRemovalUnconfirmed {
                self.message = finding + " Could not confirm removal of the saved test on this iPad. Unlock it and try Clear saved test."
            } else {
                self.message = finding + (report.cleanupUnconfirmed || cleanup == .remoteRevocationUnconfirmed ? " Test session cleanup could not be confirmed." : " Test sign-out requests were acknowledged.")
            }
        }
    }
    func checkExpiry() {
        if let credential, credential.expiresAt <= Date() { signOut(); message = "Your read-only session expired. Sign in again." }
    }
    func signOut(failureMessage: String? = nil) {
        generation = UUID()
        let ticket = generation
        detailGeneration = UUID()
        businessGeneration = UUID()
        expiry?.cancel(); expiry = nil
        browser.cancel()
        let cancellations = Array(pendingRequests.values)
        pendingRequests.removeAll()
        cancellations.forEach { $0() }
        credential = nil; user = nil; probeSucceeded = false; probeContext = nil; collection = MobileOperationCollection(); detail = nil
        businessRoots = MobileBusinessRoots(); businessProjects = MobileBusinessProjects(); selectedBusinessRoot = nil
        businessRootsLoaded = false; businessLoading = false; businessMessage = nil
        loading = false; detailLoading = false; message = failureMessage; detailMessage = nil
        PilotKeychain.clear()
        if isSyntheticProbe, let restartTest {
            let previousCleanup = savedTestCleanup
            let pendingSave = restartSaveTask
            pendingSave?.cancel()
            let cleanup = Task { () -> SyntheticAccessSignOut in
                _ = await previousCleanup?.value
                _ = try? await pendingSave?.value
                return await restartTest.signOut()
            }
            savedTestCleanup = cleanup
            Task { [weak self] in
                let result = await cleanup.value
                guard let self, self.generation == ticket else { return }
                if result == .localRemovalUnconfirmed {
                    self.message = "Could not confirm removal of the saved test on this iPad. Unlock it and try Clear saved test again."
                } else if result == .remoteRevocationUnconfirmed && self.message == nil {
                    self.message = "Saved test removed from this iPad. Cloudflare grant revocation cannot be confirmed."
                }
            }
        }
        guard let coordinator else { return }
        let liveCleanup: Task<Bool, Never>?
        if !isSyntheticProbe, let liveRestart {
            liveCleanup = Task { await liveRestart.signOut() }
        } else { liveCleanup = nil }
        let previous = signOutTask
        let check: (@Sendable (ManagedOAuthCredential) async -> SyntheticRevocationProbeResult)?
        if isSyntheticProbe, let api { check = { await api.checkSyntheticRevocation(credential: $0) } }
        else { check = nil }
        let task = Task { () -> ManagedOAuthSignOutReport in
            let prior = await previous?.value
            let localRemoval = await liveCleanup?.value ?? true
            self.liveRemovalUnconfirmed = !localRemoval
            let report = await coordinator.signOutReport(syntheticCheck: check)
            if !localRemoval || prior?.result == .revocationUnconfirmed {
                return ManagedOAuthSignOutReport(result: .revocationUnconfirmed, outcomes: report.outcomes)
            }
            return report
        }
        signOutTask = task
        Task { [weak self] in
            let report = await task.value
            guard let self, self.generation == ticket, report.result == .revocationUnconfirmed else { return }
            if self.liveRemovalUnconfirmed {
                self.message = "Signed out of this app, but Keychain could not confirm removal of the saved session. Keep the iPad unlocked and retry sign out."
                return
            }
            let primary = [self.message, ManagedOAuthDiagnostic.revocationOutcomes(report.outcomes)].compactMap { $0 }.joined(separator: " ")
            self.message = ManagedOAuthDiagnostic.withRevocationWarning(primary)
        }
    }
    private func perform<Value: Sendable>(_ operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
        let id = UUID()
        let task = Task { try await operation() }
        pendingRequests[id] = { task.cancel() }
        defer { pendingRequests[id] = nil }
        return try await task.value
    }
    func signIn() async {
        guard !loading, let coordinator, let api else { return }
        signOut()
        let ticket = generation
        loading = true
        defer { if generation == ticket { loading = false } }
        if let previous = signOutTask {
            let result = await previous.value
            guard generation == ticket else { return }
            if result.result == .revocationUnconfirmed {
                message = "The previous Cloudflare session could not be confirmed revoked. Reopen the app after the session expires."
                return
            }
        }
        if let cleanup = savedTestCleanup {
            let result = await cleanup.value
            guard generation == ticket else { return }
            if result == .localRemovalUnconfirmed {
                message = "Could not confirm removal of the saved test on this iPad. Unlock it and try Clear saved test again."
                return
            }
        }
        do {
            try await perform { try await coordinator.signIn() }
            guard generation == ticket else { return }
            guard let issued = await coordinator.currentDataCredential() else { throw MobilePilotError.expired }
            guard generation == ticket else { return }
            if isSyntheticProbe {
                let context: SyntheticAccessContext
                do { context = try await perform { try await api.verifySyntheticProbe(credential: issued) } }
                catch is CancellationError { throw CancellationError() }
                catch { throw ManagedOAuthStageFailure(stage: .probe, underlying: error) }
                guard generation == ticket, issued.expiresAt > Date() else { return }
                credential = issued; probeSucceeded = true; probeContext = context
                let remaining = max(0, issued.expiresAt.timeIntervalSinceNow)
                expiry = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
                    guard let self, self.generation == ticket else { return }
                    self.signOut(); self.message = "Your sign-in test session expired."
                }
                return
            }
            let identity = try await perform { try await api.identity(credential: issued) }
            guard generation == ticket else { return }
            let authorized = try ManagedPilotDataAPI.credential(issued, boundedBy: identity)
            credential = authorized; user = identity.user
            scheduleReadExpiry(authorized, ticket: ticket)
            let page = try await perform { try await api.operations(credential: authorized) }
            guard generation == ticket, authorized.expiresAt > Date() else { return }
            try collection.append(page, requestedCursor: nil)
            if let liveRestart {
                do { try await coordinator.saveReadOnlySession(to: liveRestart, serverSession: identity) }
                catch { message = "Signed in and loaded Operations. Keychain save failed, so this session will not restore after a restart." }
            }
        } catch {
            guard generation == ticket else { return }
            signOut(failureMessage: error is CancellationError ? nil : Self.explanation(error))
        }
    }
    func refresh() async { await load(reset: true) }
    func loadMore() async { await load(reset: false) }
    private func scheduleReadExpiry(_ credential: ManagedOAuthCredential, ticket: UUID) {
        expiry?.cancel()
        let remaining = max(0, credential.expiresAt.timeIntervalSinceNow)
        expiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
            guard let self, self.generation == ticket else { return }
            self.signOut(); self.message = "Your read-only session expired. Sign in again."
        }
    }
    private func clearBusiness() {
        businessGeneration = UUID(); businessRoots = MobileBusinessRoots(); businessProjects = MobileBusinessProjects()
        selectedBusinessRoot = nil; businessRootsLoaded = false; businessLoading = false; businessMessage = nil
    }
    func loadBusinessRoots(reset: Bool = false) async {
        guard businessEnabled, !businessLoading, let credential, let api, let currentUser = user else { return }
        guard credential.expiresAt > Date() else { signOut(failureMessage: "Your read-only session expired. Sign in again."); return }
        if reset { clearBusiness() }
        let cursor = reset || !businessRootsLoaded ? nil : businessRoots.nextCursor
        if businessRootsLoaded && !reset && cursor == nil { return }
        let ticket = generation, businessTicket = businessGeneration
        businessLoading = true; businessMessage = nil
        defer { if generation == ticket && businessGeneration == businessTicket { businessLoading = false } }
        do {
            let identity = try await perform { try await api.identity(credential: credential) }
            guard generation == ticket, businessGeneration == businessTicket else { return }
            guard identity.user.id == currentUser.id, identity.user.email == currentUser.email else { throw MobilePilotError.signedOut }
            let authorized = try ManagedPilotDataAPI.credential(credential, boundedBy: identity)
            let page = try await perform { try await api.businessRoots(credential: authorized, cursor: cursor) }
            guard generation == ticket, businessGeneration == businessTicket, authorized.expiresAt > Date() else { return }
            self.credential = authorized; scheduleReadExpiry(authorized, ticket: ticket)
            try businessRoots.append(page, requestedCursor: cursor); businessRootsLoaded = true
        } catch {
            guard generation == ticket, businessGeneration == businessTicket else { return }
            clearBusiness()
            if let failure = error as? MobilePilotError, [.signedOut, .expired].contains(failure) {
                signOut(failureMessage: Self.explanation(error))
            } else { businessMessage = "Could not load clients for this staging pilot. Check your access and try again." }
        }
    }
    func loadBusinessProjects(for root: MobileBusinessRoot, reset: Bool = false) async {
        guard businessEnabled, !businessLoading, root.isValid, let credential, let api, let currentUser = user else { return }
        guard credential.expiresAt > Date() else { signOut(failureMessage: "Your read-only session expired. Sign in again."); return }
        if selectedBusinessRoot?.id != root.id || reset {
            businessGeneration = UUID(); businessProjects = MobileBusinessProjects(); selectedBusinessRoot = root; businessMessage = nil
        }
        let cursor = businessProjects.nextCursor
        let ticket = generation, businessTicket = businessGeneration
        businessLoading = true; businessMessage = nil
        defer { if generation == ticket && businessGeneration == businessTicket { businessLoading = false } }
        do {
            let identity = try await perform { try await api.identity(credential: credential) }
            guard generation == ticket, businessGeneration == businessTicket else { return }
            guard identity.user.id == currentUser.id, identity.user.email == currentUser.email else { throw MobilePilotError.signedOut }
            let authorized = try ManagedPilotDataAPI.credential(credential, boundedBy: identity)
            let page = try await perform { try await api.businessProjects(credential: authorized, root: root, cursor: cursor) }
            guard generation == ticket, businessGeneration == businessTicket, authorized.expiresAt > Date() else { return }
            self.credential = authorized; scheduleReadExpiry(authorized, ticket: ticket)
            try businessProjects.append(page, requestedCursor: cursor)
        } catch {
            guard generation == ticket, businessGeneration == businessTicket else { return }
            businessProjects = MobileBusinessProjects()
            if let failure = error as? MobilePilotError, [.signedOut, .expired].contains(failure) {
                signOut(failureMessage: Self.explanation(error))
            } else {
                if error as? MobilePilotError == .denied { clearBusiness() }
                businessMessage = "Could not load projects for this client. Check your access and try again."
            }
        }
    }
    private func load(reset: Bool) async {
        guard !isSyntheticProbe, !loading, let credential, let api else { return }
        guard credential.expiresAt > Date() else { signOut(); message = "Your read-only session expired. Sign in again."; return }
        let ticket = generation
        let cursor = reset ? nil : collection.nextCursor
        if !reset && cursor == nil { return }
        loading = true; message = nil
        if reset { collection = MobileOperationCollection(); detail = nil; detailGeneration = UUID(); clearBusiness() }
        defer { if generation == ticket { loading = false } }
        do {
            let identity = try await perform { try await api.identity(credential: credential) }
            guard generation == ticket else { return }
            guard let existing = self.user, existing.id == identity.user.id,
                  existing.email == identity.user.email else { throw MobilePilotError.signedOut }
            let authorized = try ManagedPilotDataAPI.credential(credential, boundedBy: identity)
            self.credential = authorized; self.user = identity.user
            scheduleReadExpiry(authorized, ticket: ticket)
            let page = try await perform { try await api.operations(credential: authorized, cursor: cursor) }
            guard generation == ticket, authorized.expiresAt > Date() else { return }
            try collection.append(page, requestedCursor: cursor)
        } catch {
            guard generation == ticket else { return }
            signOut(failureMessage: Self.explanation(error))
        }
    }
    func showDetail(id: String) async {
        guard !isSyntheticProbe, let credential, let api else { return }
        detail = nil; detailMessage = nil; detailLoading = true
        detailGeneration = UUID()
        let ticket = generation, detailTicket = detailGeneration
        defer { if generation == ticket && detailGeneration == detailTicket { detailLoading = false } }
        do {
            let result = try await perform { try await api.operation(credential: credential, id: id) }
            guard generation == ticket, detailGeneration == detailTicket, credential.expiresAt > Date(),
                  (self.credential?.expiresAt ?? .distantPast) > Date() else { return }
            detail = result
        } catch {
            guard generation == ticket, detailGeneration == detailTicket else { return }
            if let failure = error as? MobilePilotError, [.signedOut, .denied, .expired].contains(failure) {
                signOut(failureMessage: Self.explanation(error))
            } else { detailMessage = Self.explanation(error) }
        }
    }
    private static func explanation(_ error: Error) -> String {
        if let failure = error as? ManagedOAuthStageFailure {
            if let browserError = failure.underlying as? ASWebAuthenticationSessionError, browserError.code == .canceledLogin { return "Sign-in cancelled." }
            if failure.stage == .probe, let diagnostic = failure.underlying as? SyntheticProbeFailure {
                return diagnostic.message
            }
            return ManagedOAuthDiagnostic.message(for: failure.stage)
        }
        if let browserError = error as? ASWebAuthenticationSessionError, browserError.code == .canceledLogin { return "Sign-in cancelled." }
        switch error as? MobilePilotError {
        case .signedOut, .expired: return "Your read-only session ended. Sign in again."
        case .denied: return "Your account does not currently have access to this pilot or operation."
        case .notFound: return "The live workspace or operation is unavailable. Please try again later."
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
                    if model.syntheticProbe {
                        if model.probeSucceeded { Text("Cloudflare sign-in test succeeded.").font(.headline) }
                        if let context = model.probeContext {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Identity check").font(.subheadline.bold())
                                Text(context.message).font(.subheadline)
                            }
                        }
                        Text("This test contains no business data.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("\(model.collection.operations.count) operations loaded").font(.headline)
                        Text("Counts and search cover loaded records only.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let message = model.message { Section { Text(message) } }
                if model.loading { ProgressView(model.syntheticProbe ? "Checking Cloudflare sign-in" : "Loading live operations") }
                if model.signedIn {
                    let matches = model.collection.operations.filter { query.isEmpty || [$0.title, $0.projectName ?? "", $0.location ?? "", $0.status].contains { $0.localizedCaseInsensitiveContains(query) } }
                    if !model.probeSucceeded { Section("Operations") {
                        if matches.isEmpty && !model.loading {
                            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("No operations were returned in the \(model.environmentName) workspace for your current access.")
                                    Text("If you expected work here, confirm it is present in this environment and visible to your Operations account.")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            } else {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("No loaded operations match “\(query)”.")
                                    Button("Clear search") { query = "" }
                                }
                            }
                        }
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
                    } }
                    if model.businessEnabled {
                        Section("Clients · staging") {
                            if let message = model.businessMessage { Text(message).font(.footnote) }
                            if model.businessLoading { ProgressView("Loading clients or projects") }
                            if !model.businessRootsLoaded && !model.businessLoading {
                                Button("Load clients") { Task { await model.loadBusinessRoots(reset: true) } }
                            }
                            if model.businessRootsLoaded && model.businessRoots.roots.isEmpty && !model.businessLoading {
                                Text(model.businessRoots.nextCursor == nil ? "No clients were returned for your current access." : "No clients on this page. More records may be available.")
                            }
                            ForEach(model.businessRoots.roots) { root in
                                NavigationLink { LiveBusinessProjects(model: model, root: root) } label: {
                                    VStack(alignment: .leading) {
                                        Text(root.name).font(.headline)
                                        Text(root.kind == "organization" ? "Organization" : "Client").font(.caption).foregroundStyle(.secondary)
                                    }
                                }.disabled(model.businessLoading)
                            }
                            if model.businessRoots.nextCursor != nil {
                                Button("Load more clients") { Task { await model.loadBusinessRoots() } }.disabled(model.businessLoading)
                            }
                            if model.businessRootsLoaded { Button("Refresh clients") { Task { await model.loadBusinessRoots(reset: true) } }.disabled(model.businessLoading) }
                            Text("Shows only loaded records permitted for this staging account.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        if model.syntheticProbe {
                            Button("Save test for restart") { Task { await model.saveRestartTest() } }.disabled(model.loading)
                            Text("Stores only test access on this iPad for up to 15 minutes. It cannot confirm that the Cloudflare grant is revoked after a restart.").font(.caption)
                            Button("Test refresh protection") { model.testSyntheticRefreshReplay() }
                            Text("Runs a test sign-out and returns to the signed-out screen. No business data is used.").font(.caption)
                        }
                        Button("Sign out", role: .destructive) { model.signOut() }
                        Text("Signing out removes this app's session and loaded data. Your browser sign-in is separate.").font(.caption)
                    }
                } else {
                    Section {
                        if model.configured {
                            Button("Sign in with Cloudflare Access") { Task { await model.signIn() } }.disabled(model.loading)
                            if model.syntheticProbe {
                                Text("Checks Cloudflare sign-in against a test endpoint with no business data.").font(.footnote)
                                Button("Restore saved test") { Task { await model.restoreRestartTest() } }.disabled(model.loading)
                                Button("Clear saved test") { model.clearRestartTest() }.disabled(model.loading)
                            } else {
                                Text("Uses your existing LT Ops staff sign-in. The pilot can only read permitted operations; sessions last up to 15 minutes.").font(.footnote)
                                Button("Restore saved session") { Task { await model.restoreLiveSession() } }.disabled(model.loading)
                                Text("Keeps only a short-lived access token in this iPad’s Keychain. Every restart checks your staff access online and reloads Operations; refresh tokens and business data are not saved.").font(.caption)
                            }
                        } else {
                            Text("Live access is not ready in this pilot build yet.")
                        }
                    }
                }
                Section { Button("Return to demo workspace") { model.useDemo() } }
            }
            .navigationTitle("LT Ops · \(model.environmentName)")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { model.useDemo() } label: {
                        Label("Back to demo", systemImage: "chevron.left")
                    }
                }
            }
            .pilotOperationControls(enabled: !model.syntheticProbe, query: $query) { await model.refresh() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { model.checkExpiry() } }
        }
    }
}

struct LiveBusinessProjects: View {
    @ObservedObject var model: LivePilotModel
    let root: MobileBusinessRoot
    var body: some View {
        List {
            Section { Label("Staging projects · read only", systemImage: "lock.shield").font(.caption.bold()) }
            if model.businessLoading { ProgressView("Loading projects") }
            if let message = model.businessMessage { Section { Text(message); Button("Try again") { Task { await model.loadBusinessProjects(for: root, reset: true) } } } }
            if model.selectedBusinessRoot?.id == root.id && !model.businessLoading && model.businessMessage == nil {
                Section("Projects") {
                    if model.businessProjects.projects.isEmpty {
                        Text(model.businessProjects.nextCursor == nil ? "No projects were returned for your current access." : "No projects on this page. More records may be available.")
                    }
                    ForEach(model.businessProjects.projects) { project in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.name).font(.headline)
                            if let status = project.status { Text(status).font(.caption).foregroundStyle(.secondary) }
                            if let start = project.startDate { Text("Start: \(start)").font(.caption) }
                            if let end = project.endDate { Text("End: \(end)").font(.caption) }
                        }
                    }
                    if model.businessProjects.nextCursor != nil {
                        Button("Load more projects") { Task { await model.loadBusinessProjects(for: root) } }.disabled(model.businessLoading)
                    }
                }
            }
        }.navigationTitle("Client projects").task(id: root.id) { await model.loadBusinessProjects(for: root, reset: true) }
    }
}

private extension View {
    @ViewBuilder
    func pilotOperationControls(enabled: Bool, query: Binding<String>, refresh: @escaping @Sendable () async -> Void) -> some View {
        if enabled {
            searchable(text: query, prompt: "Search loaded operations").refreshable(action: refresh)
        } else {
            self
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
