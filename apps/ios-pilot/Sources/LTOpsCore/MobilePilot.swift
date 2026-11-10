import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum MobilePilotError: Error, Equatable, Sendable {
    case unavailable, invalidResponse, invalidCallback, signedOut, denied, notFound, expired
}

/// This client has no arbitrary URL, method, or writable business endpoint API.
public struct MobilePilotConfiguration: Sendable {
    public static let callback = "com.ledgetoptechnologies.ops.pilot://auth/callback"
    public static let callbackScheme = "com.ledgetoptechnologies.ops.pilot"
    public static let approvedOrigins = ["https://ios-pilot-staging.ledgetop.app"]
    public let origin: URL
    public init(enabled: Bool, origin: String) throws {
        // Additional environments require a reviewed source change, not user input.
        guard enabled, Self.approvedOrigins.contains(origin), let url = URL(string: origin) else {
            throw MobilePilotError.unavailable
        }
        self.origin = url
    }
    public func authorizeURL(state: String, challenge: String) throws -> URL {
        guard Self.isBase64URL(state, range: 32...128), Self.isBase64URL(challenge, range: 43...43) else {
            throw MobilePilotError.invalidCallback
        }
        var parts = URLComponents(url: origin.appendingPathComponent("api/mobile-pilot/authorize"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "redirect_uri", value: Self.callback),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256")]
        return parts.url!
    }
    public static func callbackCode(_ url: URL, expectedState: String) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == callbackScheme, parts.host == "auth", parts.path == "/callback",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 2,
              items.filter({ $0.name == "state" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == expectedState,
              isBase64URL(expectedState, range: 32...128),
              let code = items.first(where: { $0.name == "code" })?.value,
              isBase64URL(code, range: 43...43) else { throw MobilePilotError.invalidCallback }
        return code
    }
    public static func isBase64URL(_ value: String, range: ClosedRange<Int>) -> Bool {
        range.contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

public struct MobilePilotToken: Codable, Sendable {
    public let accessToken: String
    public let tokenType: String
    public let expiresAt: Int
    public var isCurrent: Bool { tokenType == "Bearer" && Double(expiresAt) > Date().timeIntervalSince1970 }
}
public struct MobilePilotUser: Decodable, Sendable {
    public let id: String
    public let displayName: String
    public let email: String
}
public struct MobilePilotSession: Decodable, Sendable {
    public let schemaVersion: Int
    public let readOnly: Bool
    public let user: MobilePilotUser
    public let expiresAt: Int
}
public struct MobileOperation: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    /// Preserve backend vocabulary. Do not map an unknown value to a demo status.
    public let status: String
    public let scheduledStart: String?
    public let scheduledEnd: String?
    public let location: String?
    public let projectName: String?
    public let divisionName: String?
}
public struct MobileOperationsPage: Decodable, Sendable {
    public let schemaVersion: Int
    public let operations: [MobileOperation]
    public let nextCursor: String?
}
public struct MobileOperationDetail: Decodable, Sendable {
    public let schemaVersion: Int
    public let operation: MobileOperation
}

/// Pagination is loaded-record state, never a claim of a global total.
public struct MobileOperationCollection: Sendable {
    public private(set) var operations: [MobileOperation] = []
    public private(set) var nextCursor: String?
    private var consumedCursors: Set<String> = []
    private var hasLoaded = false
    public init() {}
    public mutating func append(_ page: MobileOperationsPage, requestedCursor: String?) throws {
        guard page.schemaVersion == 1, page.operations.count <= 50,
              page.operations.allSatisfy({ !$0.id.isEmpty }),
              Set(page.operations.map(\.id)).count == page.operations.count,
              requestedCursor == nextCursor, !hasLoaded || requestedCursor != nil,
              page.nextCursor.map({ !$0.isEmpty && $0.utf8.count <= 8192 && $0 != requestedCursor && !consumedCursors.contains($0) }) ?? true
        else { throw MobilePilotError.invalidResponse }
        if let requestedCursor { consumedCursors.insert(requestedCursor) }
        let known = Set(operations.map(\.id))
        operations += page.operations.filter { !known.contains($0.id) }
        nextCursor = page.nextCursor
        hasLoaded = true
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public actor MobilePilotAPI {
    private let configuration: MobilePilotConfiguration
    private let session: URLSession
    public init(configuration: MobilePilotConfiguration) {
        self.configuration = configuration
        let options = URLSessionConfiguration.ephemeral
        options.httpCookieStorage = nil
        options.httpShouldSetCookies = false
        options.urlCache = nil
        options.requestCachePolicy = .reloadIgnoringLocalCacheData
        options.timeoutIntervalForRequest = 30
        options.timeoutIntervalForResource = 45
        session = URLSession(configuration: options, delegate: NoRedirects(), delegateQueue: nil)
    }
    // Module-internal transport injection for tests; app callers use the fixed ephemeral policy.
    init(configuration: MobilePilotConfiguration, testingSession: URLSession) {
        self.configuration = configuration
        session = testingSession
    }
    deinit { session.invalidateAndCancel() }
    public func cancel() { session.getAllTasks { tasks in tasks.forEach { $0.cancel() } } }
    public func revoke(token: MobilePilotToken) async throws {
        var request = URLRequest(url: configuration.origin.appendingPathComponent("mobile-pilot/v1/session"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer " + token.accessToken, forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (_, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url,
              [204, 401].contains(response.statusCode) else { throw MobilePilotError.invalidResponse }
    }
    public func redeem(code: String, verifier: String, state: String) async throws -> MobilePilotToken {
        guard MobilePilotConfiguration.isBase64URL(code, range: 43...43),
              MobilePilotConfiguration.isBase64URL(verifier, range: 43...128),
              MobilePilotConfiguration.isBase64URL(state, range: 32...128) else { throw MobilePilotError.invalidCallback }
        var request = URLRequest(url: configuration.origin.appendingPathComponent("mobile-pilot/v1/token"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "codeVerifier": verifier,
            "state": state, "redirectUri": MobilePilotConfiguration.callback])
        let token: MobilePilotToken = try await send(request)
        guard token.isCurrent, token.accessToken.utf8.count <= 512,
              MobilePilotConfiguration.isBase64URL(token.accessToken, range: 32...512),
              Double(token.expiresAt) <= Date().timeIntervalSince1970 + 901 else { throw MobilePilotError.invalidResponse }
        return token
    }
    public func identity(token: MobilePilotToken) async throws -> MobilePilotSession {
        let result: MobilePilotSession = try await read("session", token: token)
        guard result.schemaVersion == 1, result.readOnly, result.expiresAt <= token.expiresAt,
              Double(result.expiresAt) > Date().timeIntervalSince1970 else { throw MobilePilotError.invalidResponse }
        return result
    }
    public func operations(token: MobilePilotToken, cursor: String? = nil) async throws -> MobileOperationsPage {
        let result: MobileOperationsPage = try await read("operations", token: token, cursor: cursor)
        guard result.schemaVersion == 1 else { throw MobilePilotError.invalidResponse }
        return result
    }
    public func operation(token: MobilePilotToken, id: String) async throws -> MobileOperation {
        guard !id.isEmpty, id.utf8.count <= 2048,
              let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { throw MobilePilotError.invalidResponse }
        let result: MobileOperationDetail = try await read("operations/" + encoded, token: token)
        guard result.schemaVersion == 1, result.operation.id == id else { throw MobilePilotError.invalidResponse }
        return result.operation
    }
    private func read<T: Decodable & Sendable>(_ path: String, token: MobilePilotToken, cursor: String? = nil) async throws -> T {
        guard token.isCurrent else { throw MobilePilotError.expired }
        var parts = URLComponents(string: configuration.origin.absoluteString + "/mobile-pilot/v1/" + path)!
        if let cursor {
            guard !cursor.isEmpty, cursor.utf8.count <= 8192 else { throw MobilePilotError.invalidResponse }
            parts.queryItems = [URLQueryItem(name: "cursor", value: cursor)]
        }
        var request = URLRequest(url: parts.url!)
        request.setValue("Bearer " + token.accessToken, forHTTPHeaderField: "Authorization")
        let result: T = try await send(request)
        guard token.isCurrent else { throw MobilePilotError.expired }
        return result
    }
    private func send<T: Decodable & Sendable>(_ value: URLRequest) async throws -> T {
        var request = value
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw MobilePilotError.invalidResponse }
        switch response.statusCode {
        case 200: break
        case 401: throw MobilePilotError.signedOut
        case 403: throw MobilePilotError.denied
        case 404: throw MobilePilotError.notFound
        case 503: throw MobilePilotError.unavailable
        default: throw MobilePilotError.invalidResponse
        }
        guard response.url == request.url, data.count <= 1_048_576,
              response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first == "application/json"
        else { throw MobilePilotError.invalidResponse }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw MobilePilotError.invalidResponse }
    }
}
