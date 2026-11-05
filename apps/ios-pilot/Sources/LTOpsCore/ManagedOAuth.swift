import Foundation

public enum ManagedPilotEnvironment: String, Sendable {
    case staging, production
}

public struct ManagedPilotBuildSelection: Sendable {
    public let pins: ManagedOAuthPins
    public let synthetic: Bool
    public let environment: ManagedPilotEnvironment
}

/// Build configuration never grants server authorization. Resources are fixed
/// in source; production requires separate provider and release acceptance.
public enum ManagedPilotBuildConfiguration {
    public static func selected(live: Bool, probe: Bool, environment: String,
                                productionEnabled: Bool = false) -> ManagedPilotBuildSelection? {
        guard live != probe, let environment = ManagedPilotEnvironment(rawValue: environment) else { return nil }
        switch environment {
        case .staging:
            guard !productionEnabled else { return nil }
        case .production:
            guard live, !probe, productionEnabled else { return nil }
        }
        let resource = environment == .staging
            ? "https://ios-pilot-staging.ledgetop.app"
            : "https://ios-pilot.ledgetop.app"
        let issuer = "https://ledgetoptechnologies.cloudflareaccess.com"
        guard let pins = try? ManagedOAuthPins(resource: resource, issuer: issuer,
            authorizationEndpoint: issuer + "/cdn-cgi/access/oauth/authorization",
            tokenEndpoint: issuer + "/cdn-cgi/access/oauth/token",
            registrationEndpoint: issuer + "/cdn-cgi/access/oauth/registration",
            revocationEndpoint: issuer + "/cdn-cgi/access/oauth/revoke") else { return nil }
        return ManagedPilotBuildSelection(pins: pins, synthetic: probe, environment: environment)
    }
}

/// Experimental, unmounted wire-format helpers. The deployment must supply
/// reviewed pins and verify provider behavior before this is used for sign-in.
/// This type does not perform networking, store credentials, or authorize data.
/// Callers must generate cryptographically random state and verifier and derive
/// the S256 challenge from that same verifier; this wire helper cannot prove it.
public struct ManagedOAuthPins: Sendable {
    public let resource: String
    public let issuer: String
    public let authorizationEndpoint: String
    public let tokenEndpoint: String
    public let registrationEndpoint: String
    public let revocationEndpoint: String

    public init(resource: String, issuer: String, authorizationEndpoint: String,
                tokenEndpoint: String, registrationEndpoint: String, revocationEndpoint: String) throws {
        guard Self.isHTTPSOrigin(resource), Self.isHTTPSOrigin(issuer), resource != issuer,
              [authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint].allSatisfy({ Self.isEndpoint($0, issuer: issuer) }),
              Set([authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint]).count == 4 else {
            throw MobilePilotError.invalidResponse
        }
        self.resource = resource
        self.issuer = issuer
        self.authorizationEndpoint = authorizationEndpoint
        self.tokenEndpoint = tokenEndpoint
        self.registrationEndpoint = registrationEndpoint
        self.revocationEndpoint = revocationEndpoint
    }
    private static func isHTTPSOrigin(_ value: String) -> Bool {
        guard let url = URLComponents(string: value), url.scheme == "https", let host = url.host,
              !host.isEmpty, url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty, url.query == nil, url.fragment == nil else { return false }
        return url.string == value
    }
    private static func isEndpoint(_ value: String, issuer: String) -> Bool {
        guard let url = URLComponents(string: value), url.scheme == "https", let host = url.host,
              let issuerURL = URLComponents(string: issuer), host == issuerURL.host,
              url.user == nil, url.password == nil, url.port == nil,
              url.path.hasPrefix("/"), url.path != "/", url.query == nil, url.fragment == nil else { return false }
        return url.string == value
    }
}

public struct ManagedOAuthMetadata: Decodable, Sendable {
    public let issuer: String
    public let authorization_endpoint: String
    public let token_endpoint: String
    public let registration_endpoint: String
    public let revocation_endpoint: String
    public let response_types_supported: [String]
    public let grant_types_supported: [String]
    public let token_endpoint_auth_methods_supported: [String]
    public let code_challenge_methods_supported: [String]

    public func validate(pins: ManagedOAuthPins) throws {
        guard issuer == pins.issuer, authorization_endpoint == pins.authorizationEndpoint,
              token_endpoint == pins.tokenEndpoint, registration_endpoint == pins.registrationEndpoint,
              revocation_endpoint == pins.revocationEndpoint,
              response_types_supported.contains("code"), grant_types_supported.contains("authorization_code"),
              token_endpoint_auth_methods_supported.contains("none"), code_challenge_methods_supported.contains("S256") else {
            throw MobilePilotError.invalidResponse
        }
    }
}

public enum ManagedOAuthWire {
    // Callback scheme support is unverified and must not be enabled by this helper.
    public static let callback = MobilePilotConfiguration.callback

    public static func registrationBody(pins: ManagedOAuthPins) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["redirect_uris": [callback],
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code"],
            "response_types": ["code"], "resource": pins.resource], options: [.sortedKeys])
    }

    public static func registeredClient(_ data: Data) throws -> String {
        guard data.count <= 65_536,
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let client = obj["client_id"] as? String, clientIDValid(client),
              let redirects = obj["redirect_uris"] as? [String], redirects == [callback],
              obj["token_endpoint_auth_method"] as? String == "none",
              let grants = obj["grant_types"] as? [String], grants == ["authorization_code"],
              let responses = obj["response_types"] as? [String], responses == ["code"],
              obj["client_secret"] == nil else { throw MobilePilotError.invalidResponse }
        return client
    }

    public static func authorizationURL(pins: ManagedOAuthPins, clientID: String, state: String, challenge: String) throws -> URL {
        guard clientIDValid(clientID), MobilePilotConfiguration.isBase64URL(state, range: 32...128),
              MobilePilotConfiguration.isBase64URL(challenge, range: 43...43),
              let first = challenge.utf8.first, (48...57).contains(first) || (65...90).contains(first) || (97...122).contains(first),
              var parts = URLComponents(string: pins.authorizationEndpoint) else { throw MobilePilotError.invalidResponse }
        parts.queryItems = [URLQueryItem(name: "client_id", value: clientID), URLQueryItem(name: "redirect_uri", value: callback),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "resource", value: pins.resource),
            URLQueryItem(name: "state", value: state)]
        guard let url = parts.url else { throw MobilePilotError.invalidResponse }
        return url
    }

    public static func callbackCode(_ url: URL, state: String) throws -> String {
        guard MobilePilotConfiguration.isBase64URL(state, range: 32...128),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == MobilePilotConfiguration.callbackScheme, parts.host == "auth", parts.path == "/callback",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 2,
              items.filter({ $0.name == "state" }).count == 1, items.filter({ $0.name == "code" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value, opaque(code, max: 2048) else {
            throw MobilePilotError.invalidCallback
        }
        return code
    }

    public static func exchangeBody(code: String, verifier: String, clientID: String) throws -> Data {
        guard opaque(code, max: 2048), clientIDValid(clientID),
              MobilePilotConfiguration.isBase64URL(verifier, range: 43...128) else { throw MobilePilotError.invalidCallback }
        return Data(form([("grant_type", "authorization_code"), ("code", code), ("client_id", clientID),
                          ("redirect_uri", callback), ("code_verifier", verifier)]).utf8)
    }

    public static func refreshBody(refreshToken: String, clientID: String) throws -> Data {
        guard opaque(refreshToken, max: 4096), refreshToken.hasPrefix("oauth:"), clientIDValid(clientID) else {
            throw MobilePilotError.invalidResponse
        }
        return Data(form([("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", clientID)]).utf8)
    }

    // Only visible ASCII is accepted; never print or persist these values.
    private static func opaque(_ value: String, max: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= max && value.utf8.allSatisfy { (33...126).contains($0) }
    }
    private static func clientIDValid(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 512 && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 || $0 == 46 || $0 == 126
        }
    }
    private static func form(_ pairs: [(String, String)]) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return pairs.map { key, value in
            key.addingPercentEncoding(withAllowedCharacters: unreserved)! + "=" + value.addingPercentEncoding(withAllowedCharacters: unreserved)!
        }.joined(separator: "&")
    }
}
