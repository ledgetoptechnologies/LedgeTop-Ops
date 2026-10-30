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
    public func verifySyntheticProbe(credential: ManagedOAuthCredential) async throws {
        struct Probe: Decodable, Sendable { let ok: Bool; let kind: String }
        do {
            let result: Probe = try await read(path: "", credential: credential, syntheticProbe: true)
            guard result.ok, result.kind == "synthetic-oauth-probe" else { throw SyntheticProbeFailure.unexpectedResponse }
        } catch is CancellationError { throw CancellationError() }
        catch let failure as SyntheticProbeFailure { throw failure }
        catch let failure as MobilePilotError {
            throw failure == .expired ? SyntheticProbeFailure.expired : SyntheticProbeFailure.unexpectedResponse
        } catch { throw SyntheticProbeFailure.network }
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
        let data = try await PilotDataCollector(url: url, syntheticProbe: syntheticProbe).begin(request, protocolClasses: protocolClasses)
        try Task.checkCancellation()
        guard credential.expiresAt > Date() else { throw MobilePilotError.expired }
        do { return try JSONDecoder().decode(T.self, from: data) }
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
    private var continuation: CheckedContinuation<Data, Error>?
    private var failure: Error?
    private var validated = false
    private var cancelled = false

    init(url: URL, syntheticProbe: Bool) { self.url = url; self.syntheticProbe = syntheticProbe }
    func begin(_ request: URLRequest, protocolClasses: [AnyClass]?) async throws -> Data {
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
        lock.lock(); validated = true; lock.unlock(); completionHandler(.allow)
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
        let result = data
        let failure: Error? = cancelled ? CancellationError() : (self.failure ?? error ?? (validated ? nil : MobilePilotError.invalidResponse))
        lock.unlock()
        session.finishTasksAndInvalidate()
        if let failure { continuation?.resume(throwing: failure) } else { continuation?.resume(returning: result) }
    }
}
