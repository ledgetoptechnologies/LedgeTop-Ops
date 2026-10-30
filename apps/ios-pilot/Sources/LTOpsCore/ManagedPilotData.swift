import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Fixed diagnostic categories for the synthetic probe only. These never
/// contain a token, identity, server response body, or raw network error.
public enum SyntheticProbeFailure: Error, Sendable, Equatable {
    case credential, expired, network, unexpectedResponse, edgeUnauthorized
    case originUnavailable, originRequest, originBearer, originAssertionMissing, originAssertionInvalid
    public var message: String {
        switch self {
        case .credential: return "The test credential format was not accepted by the app."
        case .expired: return "The test credential expired before the connection completed."
        case .network: return "The test connection could not reach Cloudflare."
        case .unexpectedResponse: return "The test connection received an unexpected response."
        case .edgeUnauthorized: return "The test connection returned an authorization error without a diagnostic marker."
        case .originUnavailable: return "The test service is unavailable or the request path was rejected."
        case .originRequest: return "The test service rejected request headers."
        case .originBearer: return "The test service did not receive a valid bearer header."
        case .originAssertionMissing: return "The test service did not receive an Access assertion."
        case .originAssertionInvalid: return "The test service could not verify the Access assertion."
        }
    }
}

/// Fixed, synthetic-only observations. Unknown or missing provider headers
/// never appear verbatim and do not change the authentication result.
public enum SyntheticAccessContext: Sendable, Equatable {
    case match, missing, audienceMismatch, identityUnavailable, identityMismatch, unknown
    public var message: String {
        switch self {
        case .match: return "Access context and signed identity matched in the test."
        case .missing: return "The test service did not receive an Access context."
        case .audienceMismatch: return "The test Access context had a different audience."
        case .identityUnavailable: return "The test Access identity was unavailable."
        case .identityMismatch: return "The test Access identity did not match the signed assertion."
        case .unknown: return "The Access context check is unavailable or unrecognized."
        }
    }
    fileprivate static func from(_ value: String?) -> Self {
        switch value {
        case "match": return .match
        case "missing": return .missing
        case "audience-mismatch": return .audienceMismatch
        case "identity-unavailable": return .identityUnavailable
        case "identity-mismatch": return .identityMismatch
        default: return .unknown
        }
    }
}

private struct PilotDataResponse: Sendable {
    let data: Data
    let context: SyntheticAccessContext
}

/// Unmounted pilot-only data transport. A caller must supply independently reviewed
/// pins, guard session generations around results, and verify ingress in staging.
/// This API cannot construct arbitrary methods, hosts, or business-write paths.
public struct ManagedPilotDataAPI: Sendable {
    private let pins: ManagedOAuthPins
    private let protocolClasses: [AnyClass]?

    public init(pins: ManagedOAuthPins) {
        self.pins = pins
        self.protocolClasses = nil
    }
    // Internal injection for synthetic tests. App code uses the fixed transport.
    init(pins: ManagedOAuthPins, protocolClasses: [AnyClass]) {
        self.pins = pins
        self.protocolClasses = protocolClasses
    }

    /// Test-only fixed endpoint. This returns no staff or business information.
    @discardableResult public func verifySyntheticProbe(credential: ManagedOAuthCredential) async throws -> SyntheticAccessContext {
        // Never send a synthetic probe credential to an arbitrary resource.
        // The app's reviewed probe configuration and revocation check use the
        // same exact, no-business-data origin.
        guard pins.resource == SyntheticRefreshExperiment.resource else { throw SyntheticProbeFailure.unexpectedResponse }
        struct Probe: Decodable, Sendable { let ok: Bool; let kind: String }
        do {
            let (result, context): (Probe, SyntheticAccessContext) = try await readResponse(path: "", credential: credential, syntheticProbe: true)
            guard result.ok, result.kind == "synthetic-oauth-probe" else { throw SyntheticProbeFailure.unexpectedResponse }
            return context
        } catch is CancellationError { throw CancellationError() }
        catch let failure as SyntheticProbeFailure { throw failure }
        catch let failure as MobilePilotError {
            throw failure == .expired ? SyntheticProbeFailure.expired : SyntheticProbeFailure.unexpectedResponse
        } catch { throw SyntheticProbeFailure.network }
    }

    /// Fixed no-data origin only; neither success nor 401 proves why Access
    /// made its decision, or that a refresh token cannot be replayed.
    public func checkSyntheticRevocation(credential: ManagedOAuthCredential) async -> SyntheticRevocationProbeResult {
        guard pins.resource == "https://ios-pilot-staging.ledgetop.app", credential.expiresAt > Date(), !Task.isCancelled else { return .inconclusive }
        do {
            try await verifySyntheticProbe(credential: credential)
            return credential.expiresAt > Date() && !Task.isCancelled ? .accepted : .inconclusive
        } catch SyntheticProbeFailure.edgeUnauthorized {
            return credential.expiresAt > Date() && !Task.isCancelled ? .rejected : .inconclusive
        } catch { return .inconclusive }
    }

    public func identity(credential: ManagedOAuthCredential) async throws -> MobilePilotSession {
        let result: MobilePilotSession = try await read(path: "session", credential: credential)
        guard result.schemaVersion == 1, result.readOnly,
              Double(result.expiresAt) > Date().timeIntervalSince1970,
              !result.user.id.isEmpty else { throw MobilePilotError.invalidResponse }
        return result
    }

    public func operations(credential: ManagedOAuthCredential, cursor: String? = nil) async throws -> MobileOperationsPage {
        let result: MobileOperationsPage = try await read(path: "operations", cursor: cursor, credential: credential)
        guard result.schemaVersion == 1 else { throw MobilePilotError.invalidResponse }
        return result
    }

    public func operation(credential: ManagedOAuthCredential, id: String) async throws -> MobileOperation {
        guard !id.isEmpty, id != ".", id != "..", id.utf8.count <= 512,
              let encoded = id.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"))
        else { throw MobilePilotError.invalidResponse }
        let result: MobileOperationDetail = try await read(path: "operations/" + encoded, credential: credential)
        guard result.schemaVersion == 1, result.operation.id == id else { throw MobilePilotError.invalidResponse }
        return result.operation
    }

    private func read<T: Decodable & Sendable>(path: String, cursor: String? = nil, credential: ManagedOAuthCredential,
                                               syntheticProbe: Bool = false) async throws -> T {
        let (result, _): (T, SyntheticAccessContext) = try await readResponse(path: path, cursor: cursor, credential: credential, syntheticProbe: syntheticProbe)
        return result
    }
    private func readResponse<T: Decodable & Sendable>(path: String, cursor: String? = nil, credential: ManagedOAuthCredential,
                                                       syntheticProbe: Bool = false) async throws -> (T, SyntheticAccessContext) {
        try Task.checkCancellation()
        guard credential.expiresAt > Date() else { throw MobilePilotError.expired }
        let token = credential.accessToken
        guard token.hasPrefix("oauth:"), (7...4096).contains(token.utf8.count),
              token.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) ||
                  (48...57).contains($0) || [45,46,95,126,58,43,47,61].contains($0) })
        else {
            if syntheticProbe { throw SyntheticProbeFailure.credential }
            throw MobilePilotError.invalidResponse
        }
        let endpoint = syntheticProbe ? "/oauth-probe/v1" : "/mobile-pilot/v1/" + path
        guard var components = URLComponents(string: pins.resource + endpoint) else { throw MobilePilotError.invalidResponse }
        if let cursor {
            guard !cursor.isEmpty, cursor.utf8.count <= 8192 else { throw MobilePilotError.invalidResponse }
            components.queryItems = [URLQueryItem(name: "cursor", value: cursor)]
        }
        guard let url = components.url else { throw MobilePilotError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let response = try await PilotDataCollector(url: url, syntheticProbe: syntheticProbe).begin(request, protocolClasses: protocolClasses)
        try Task.checkCancellation()
        guard credential.expiresAt > Date() else { throw MobilePilotError.expired }
        do { return (try JSONDecoder().decode(T.self, from: response.data), response.context) }
        catch { throw MobilePilotError.invalidResponse }
    }
}

/// The delegate caps bytes as they arrive, rejects redirects, and does not use
/// ambient cookies or disk caches. Each request owns its session and delegate.
private final class PilotDataCollector: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private let syntheticProbe: Bool
    private let limit = 1_048_576
    private var data = Data()
    private var task: URLSessionDataTask?
    private var continuation: CheckedContinuation<PilotDataResponse, Error>?
    private var failure: Error?
    private var validated = false
    private var cancelled = false
    private var context: SyntheticAccessContext = .unknown

    init(url: URL, syntheticProbe: Bool) { self.url = url; self.syntheticProbe = syntheticProbe }
    func begin(_ request: URLRequest, protocolClasses: [AnyClass]?) async throws -> PilotDataResponse {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let options = URLSessionConfiguration.ephemeral
                options.httpCookieStorage = nil
                options.httpShouldSetCookies = false
                options.urlCache = nil
                options.requestCachePolicy = .reloadIgnoringLocalCacheData
                options.timeoutIntervalForRequest = 30
                options.timeoutIntervalForResource = 45
                options.protocolClasses = protocolClasses
                let session = URLSession(configuration: options, delegate: self, delegateQueue: nil)
                let task = session.dataTask(with: request)
                lock.lock(); self.continuation = continuation; self.task = task; let shouldCancel = cancelled; lock.unlock()
                if shouldCancel { task.cancel() } else { task.resume() }
            }
        } onCancel: {
            self.lock.lock(); self.cancelled = true; let task = self.task; self.lock.unlock()
            task?.cancel()
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.url == url else {
            lock.lock(); failure = MobilePilotError.invalidResponse; lock.unlock(); completionHandler(.cancel); return
        }
        if syntheticProbe && response.statusCode != 200 {
            let stage = response.value(forHTTPHeaderField: "X-LT-Ops-Probe-Stage")
            let diagnosis: SyntheticProbeFailure
            switch (response.statusCode, stage) {
            case (404, "unavailable"): diagnosis = .originUnavailable
            case (401, "request-rejected"): diagnosis = .originRequest
            case (401, "bearer-rejected"): diagnosis = .originBearer
            case (401, "assertion-missing"): diagnosis = .originAssertionMissing
            case (401, "assertion-invalid"): diagnosis = .originAssertionInvalid
            case (401, nil): diagnosis = .edgeUnauthorized
            default: diagnosis = .unexpectedResponse
            }
            lock.lock(); failure = diagnosis; lock.unlock(); completionHandler(.cancel); return
        }
        let statusError: MobilePilotError?
        switch response.statusCode {
        case 200: statusError = nil
        case 401: statusError = .signedOut
        case 403: statusError = .denied
        case 404: statusError = .notFound
        case 503: statusError = .unavailable
        default: statusError = .invalidResponse
        }
        guard statusError == nil,
              response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "application/json",
              response.expectedContentLength < 0 || response.expectedContentLength <= limit else {
            lock.lock(); failure = statusError ?? MobilePilotError.invalidResponse; lock.unlock(); completionHandler(.cancel); return
        }
        lock.lock()
        if syntheticProbe && response.value(forHTTPHeaderField: "X-LT-Ops-Probe-Stage") == "ok" {
            context = .from(response.value(forHTTPHeaderField: "X-LT-Ops-Access-Context"))
        }
        validated = true; lock.unlock(); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive incoming: Data) {
        lock.lock()
        if incoming.count > limit - data.count {
            failure = MobilePilotError.invalidResponse; lock.unlock(); dataTask.cancel(); return
        }
        data.append(incoming); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let continuation = self.continuation; self.continuation = nil
        let result = PilotDataResponse(data: data, context: context)
        let failure: Error? = cancelled ? CancellationError() : (self.failure ?? error ?? (validated ? nil : MobilePilotError.invalidResponse))
        lock.unlock()
        session.finishTasksAndInvalidate()
        if let failure { continuation?.resume(throwing: failure) } else { continuation?.resume(returning: result) }
    }
}
