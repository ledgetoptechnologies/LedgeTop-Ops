import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// This experimental transport has no app wiring or deployed endpoint pins.
/// It does not generate PKCE values, retain credentials or perform refresh.
public struct ManagedOAuthCredential: Sendable {
    public let accessToken: String
    public let refreshToken: String?
    public let expiresAt: Date
}

private final class OAuthResponseCollector: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let expectedURL: URL
    private let successCodes: Set<Int>
    private let requiresJSON: Bool
    private let diagnoseRevocation: Bool
    private let maxBytes = 65_536
    private var body = Data()
    private var failure: Error?
    private var continuation: CheckedContinuation<Data, Error>?
    private var task: URLSessionDataTask?
    private var cancelled = false
    private var validatedResponse = false
    init(expectedURL: URL, successCodes: Set<Int>, requiresJSON: Bool = true, diagnoseRevocation: Bool = false) {
        self.expectedURL = expectedURL; self.successCodes = successCodes; self.requiresJSON = requiresJSON; self.diagnoseRevocation = diagnoseRevocation
    }

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
                lock.lock()
                self.continuation = continuation
                self.task = task
                let shouldCancel = cancelled
                lock.unlock()
                if shouldCancel { task.cancel() } else { task.resume() }
            }
        } onCancel: {
            self.lock.lock()
            self.cancelled = true
            let task = self.task
            self.lock.unlock()
            task?.cancel()
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        if diagnoseRevocation { lock.lock(); failure = ManagedOAuthRevocationFailure.redirect; lock.unlock() }
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        if diagnoseRevocation, let response = response as? HTTPURLResponse, response.url == expectedURL,
           !successCodes.contains(response.statusCode) {
            let kind: ManagedOAuthRevocationFailure = response.statusCode == 401 ? .httpUnauthorized
                : [400, 403, 404, 405, 409, 415, 422, 429].contains(response.statusCode) ? .httpStatus(response.statusCode)
                : (400...499).contains(response.statusCode) ? .httpClientError
                : (500...599).contains(response.statusCode) ? .httpServerError : .invalidResponse
            lock.lock(); if failure == nil { failure = kind }; lock.unlock()
            completionHandler(.cancel); return
        }
        guard let response = response as? HTTPURLResponse, response.url == expectedURL,
              successCodes.contains(response.statusCode),
              (!requiresJSON || response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "application/json"),
              response.expectedContentLength < 0 || response.expectedContentLength <= maxBytes else {
            lock.lock(); if failure == nil { failure = diagnoseRevocation ? ManagedOAuthRevocationFailure.invalidResponse : MobilePilotError.invalidResponse }; lock.unlock()
            completionHandler(.cancel); return
        }
        lock.lock(); validatedResponse = true; lock.unlock()
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if data.count > maxBytes - body.count {
            failure = MobilePilotError.invalidResponse
            lock.unlock()
            dataTask.cancel()
            return
        }
        body.append(data)
        lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        let failure: Error? = cancelled ? CancellationError() : (self.failure ?? error ?? (validatedResponse ? nil : MobilePilotError.invalidResponse))
        let result = body
        lock.unlock()
        session.finishTasksAndInvalidate()
        if let failure { continuation?.resume(throwing: failure) }
        else { continuation?.resume(returning: result) }
    }
}

/// A single-use connection per request prevents stale cookies or redirects
/// from moving authorization data outside the pinned origin.
public struct ManagedOAuthTransport: Sendable {
    private let pins: ManagedOAuthPins
    private let protocolClasses: [AnyClass]?
    public init(pins: ManagedOAuthPins) { self.pins = pins; protocolClasses = nil }
    // Test-only transport injection. App callers cannot replace the transport.
    init(pins: ManagedOAuthPins, protocolClasses: [AnyClass]) { self.pins = pins; self.protocolClasses = protocolClasses }

    public func verifyMetadata() async throws {
        // Cloudflare serves the resource-specific metadata on the protected
        // application origin. The metadata issuer and endpoints are still
        // checked against their independent, source-reviewed pins below.
        let url = URL(string: pins.resource + "/.well-known/oauth-authorization-server")!
        let data = try await request(url, method: "GET", contentType: nil, body: nil, successCodes: [200])
        try Task.checkCancellation()
        do { try JSONDecoder().decode(ManagedOAuthMetadata.self, from: data).validate(pins: pins) }
        catch { throw MobilePilotError.invalidResponse }
        try Task.checkCancellation()
    }
    public func register() async throws -> String {
        let data = try await request(URL(string: pins.registrationEndpoint)!, method: "POST", contentType: "application/json",
                                     body: ManagedOAuthWire.registrationBody(pins: pins), successCodes: [200, 201])
        try Task.checkCancellation()
        let client: String
        do { client = try ManagedOAuthWire.registeredClient(data) }
        catch { throw MobilePilotError.invalidResponse }
        try Task.checkCancellation()
        return client
    }
    public func exchange(code: String, verifier: String, clientID: String) async throws -> ManagedOAuthCredential {
        let sentAt = Date()
        let data = try await request(URL(string: pins.tokenEndpoint)!, method: "POST", contentType: "application/x-www-form-urlencoded",
                                     body: ManagedOAuthWire.exchangeBody(code: code, verifier: verifier, clientID: clientID), successCodes: [200])
        // If a response has arrived, preserve issued tokens for the coordinator
        // to revoke even if cancellation raced the completed HTTP request.
        return try parseCredential(data, sentAt: sentAt, priorRefresh: nil)
    }
    public func refresh(token: String, clientID: String) async throws -> ManagedOAuthCredential {
        let sentAt = Date()
        let data = try await request(URL(string: pins.tokenEndpoint)!, method: "POST", contentType: "application/x-www-form-urlencoded",
            body: ManagedOAuthWire.refreshBody(refreshToken: token, clientID: clientID), successCodes: [200])
        return try parseCredential(data, sentAt: sentAt, priorRefresh: token)
    }
    /// Synthetic experiment only: do not fill in an omitted refresh token.
    public func strictRefresh(token: String, clientID: String) async throws -> ManagedOAuthCredential {
        guard pins.resource == SyntheticRefreshExperiment.resource,
              pins.issuer == "https://ledgetoptechnologies.cloudflareaccess.com",
              pins.tokenEndpoint == pins.issuer + "/cdn-cgi/access/oauth/token" else { throw MobilePilotError.unavailable }
        let sentAt = Date()
        let data = try await request(URL(string: pins.tokenEndpoint)!, method: "POST", contentType: "application/x-www-form-urlencoded",
            body: ManagedOAuthWire.refreshBody(refreshToken: token, clientID: clientID), successCodes: [200], diagnoseRevocation: true)
        return try parseCredential(data, sentAt: sentAt, priorRefresh: nil)
    }
    private func parseCredential(_ data: Data, sentAt: Date, priorRefresh: String?) throws -> ManagedOAuthCredential {
        struct Response: Decodable { let access_token: String; let token_type: String; let expires_in: Int; let resource: String; let refresh_token: String? }
        guard let result = try? JSONDecoder().decode(Response.self, from: data),
              result.token_type.lowercased() == "bearer", (1...900).contains(result.expires_in),
              result.resource == pins.resource || result.resource == pins.resource + "/",
              Self.tokenValid(result.access_token), result.refresh_token.map(Self.tokenValid) ?? true else {
            throw MobilePilotError.invalidResponse
        }
        let expiry = sentAt.addingTimeInterval(TimeInterval(result.expires_in))
        // Expiry is checked by the coordinator, which still needs the token to
        // attempt revocation when a slow exchange has already expired.
        return ManagedOAuthCredential(accessToken: result.access_token, refreshToken: result.refresh_token ?? priorRefresh, expiresAt: expiry)
    }
    /// RFC 7009 permits an empty HTTP 200 response even for an invalid token.
    /// A successful return means only that the provider accepted the request.
    public func revoke(token: String, clientID: String, hint: ManagedOAuthTokenKind) async throws {
        guard Self.tokenValid(token), !clientID.isEmpty, clientID.utf8.count <= 512,
              clientID.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 || $0 == 46 || $0 == 126 }) else {
            throw ManagedOAuthRevocationFailure.localValidation
        }
        let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let values = [("token", token), ("token_type_hint", hint.rawValue), ("client_id", clientID)]
        let form = values.map { $0.0 + "=" + $0.1.addingPercentEncoding(withAllowedCharacters: safe)! }.joined(separator: "&")
        do {
            _ = try await request(URL(string: pins.revocationEndpoint)!, method: "POST", contentType: "application/x-www-form-urlencoded",
                                  body: Data(form.utf8), successCodes: [200], requiresJSON: false, diagnoseRevocation: true)
        } catch let error as ManagedOAuthRevocationFailure { throw error }
        catch is CancellationError { throw CancellationError() }
        catch is URLError { throw ManagedOAuthRevocationFailure.network }
        catch { throw ManagedOAuthRevocationFailure.invalidResponse }
        try Task.checkCancellation()
    }
    private static func tokenValid(_ value: String) -> Bool {
        value.hasPrefix("oauth:") && (7...4096).contains(value.utf8.count) && value.utf8.allSatisfy { (33...126).contains($0) }
    }
    private func request(_ url: URL, method: String, contentType: String?, body: Data?, successCodes: Set<Int>, requiresJSON: Bool = true, diagnoseRevocation: Bool = false) async throws -> Data {
        var value = URLRequest(url: url)
        value.httpMethod = method
        value.httpBody = body
        value.setValue("application/json", forHTTPHeaderField: "Accept")
        value.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let contentType { value.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return try await OAuthResponseCollector(expectedURL: url, successCodes: successCodes, requiresJSON: requiresJSON, diagnoseRevocation: diagnoseRevocation).begin(value, protocolClasses: protocolClasses)
    }
}

public enum ManagedOAuthTokenKind: String, Sendable { case access = "access_token", refresh = "refresh_token" }
extension ManagedOAuthTransport: SyntheticRefreshTransport {}
public enum ManagedOAuthRevocationFailure: Error, Sendable, Equatable {
    case localValidation, httpUnauthorized, httpClientError, httpServerError, redirect, network, invalidResponse
    case httpStatus(Int)
}
