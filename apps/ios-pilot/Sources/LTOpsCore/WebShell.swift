import Foundation

// Hybrid shell core: which pages the embedded web view may show, and strict
// validation of requests the page sends to the app. Platform-independent so it
// is covered by package tests. Contract: Hub note
// ledge-top-ops / ui/app-web-bridge-contract-draft-20261110.md (draft v0.2).

/// An exact https origin. No wildcards, user info, IP literals, or localhost.
public struct WebShellOrigin: Hashable, Sendable {
    public let host: String
    public let port: Int

    /// Parses a configured origin such as `https://ops.example.com`.
    public init?(configured text: String) {
        guard text.utf8.count <= 255, !text.contains("*"), !text.contains("@"),
              let parts = URLComponents(string: text), parts.scheme == "https",
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let host = parts.host, WebShellOrigin.validHost(host) else { return nil }
        if let port = parts.port, !(1...65535).contains(port) { return nil }
        self.host = host
        self.port = parts.port ?? 443
        // Reject spellings a URL parser would silently normalize.
        let canonical = self.port == 443 ? "https://\(host)" : "https://\(host):\(self.port)"
        guard text == canonical || text == canonical + "/" else { return nil }
    }

    /// The origin of a navigated URL, or nil when it is not an acceptable https origin.
    public init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: true), parts.scheme == "https",
              parts.user == nil, parts.password == nil,
              let host = parts.host, WebShellOrigin.validHost(host) else { return nil }
        if let port = parts.port, !(1...65535).contains(port) { return nil }
        self.host = host
        self.port = parts.port ?? 443
    }

    public var url: URL { URL(string: port == 443 ? "https://\(host)/" : "https://\(host):\(port)/")! }

    private static func validHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253, host == host.lowercased(), host != "localhost",
              !host.hasSuffix(".localhost"), !host.hasSuffix(".local"), host.contains(".") else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-") &&
            label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
        }) else { return false }
        // A numeric final label means an IPv4 literal, never a registered name.
        return labels.last.map { !$0.utf8.allSatisfy { (48...57).contains($0) } } ?? false
    }
}

/// The release owner's allowlist. Any invalid entry disables the shell entirely.
public struct WebShellConfiguration: Sendable, Equatable {
    public let origins: Set<WebShellOrigin>
    public let start: URL

    public init?(origins configured: [String], startPath: String = "/") {
        guard !configured.isEmpty, configured.count <= 8 else { return nil }
        var parsed: [WebShellOrigin] = []
        for text in configured {
            guard let origin = WebShellOrigin(configured: text) else { return nil }
            parsed.append(origin)
        }
        guard Set(parsed).count == parsed.count, startPath.hasPrefix("/"), !startPath.hasPrefix("//"),
              startPath.utf8.count <= 512, !startPath.contains("\\"), !startPath.contains("?"),
              !startPath.contains("#"), !startPath.contains(".."),
              !startPath.unicodeScalars.contains(where: { $0.value <= 32 || $0.value >= 127 }),
              let start = URL(string: String(parsed[0].url.absoluteString.dropLast()) + startPath),
              WebShellOrigin(url: start) == parsed[0] else { return nil }
        origins = Set(parsed)
        self.start = start
    }

    public func allows(_ url: URL) -> Bool { WebShellOrigin(url: url).map(origins.contains) ?? false }
}

public extension WebShellConfiguration {
    /// True only when the build explicitly turns the web workspace on.
    static func isEnabled(_ info: [String: Any]?) -> Bool { info?["LTOpsWebShellEnabled"] as? Bool == true }

    /// Reads the build's Info.plist values. Off unless enabled with a fully valid allowlist.
    static func fromInfo(_ info: [String: Any]?) -> WebShellConfiguration? {
        guard let info, isEnabled(info), let origins = info["LTOpsWebShellOrigins"] as? [String] else { return nil }
        guard let path = info["LTOpsWebShellStartPath"] else { return WebShellConfiguration(origins: origins) }
        guard let path = path as? String else { return nil }
        return WebShellConfiguration(origins: origins, startPath: path)
    }
}

public enum WebShellNavigationDecision: Equatable, Sendable {
    /// Load inside the embedded web view.
    case allow
    /// Hand the address to the system browser.
    case external(URL)
    /// A sign-in page: never shown in the web view; the native sign-in takes over.
    case nativeSignIn
    case cancel
}

public struct WebShellNavigationPolicy: Sendable {
    public let configuration: WebShellConfiguration
    public init(configuration: WebShellConfiguration) { self.configuration = configuration }

    public func decide(url: URL?, isMainFrame: Bool, userInitiated: Bool) -> WebShellNavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme != "https" {
            if isMainFrame {
                if url.absoluteString == "about:blank" { return .allow }
                return userInitiated && (scheme == "mailto" || scheme == "tel") ? .external(url) : .cancel
            }
            return scheme == "about" || scheme == "blob" ? .allow : .cancel
        }
        guard let origin = WebShellOrigin(url: url) else { return .cancel }
        if WebShellNavigationPolicy.isSignIn(host: origin.host, path: url.path) {
            return isMainFrame ? .nativeSignIn : .cancel
        }
        // Embedded frames (maps, the 3D viewer) may load https content; the bridge never reaches them.
        guard isMainFrame else { return .allow }
        if configuration.origins.contains(origin) { return .allow }
        return userInitiated ? .external(url) : .cancel
    }

    /// Cloudflare Access login and identity-provider hand-offs.
    static func isSignIn(host: String, path: String) -> Bool {
        host == "cloudflareaccess.com" || host.hasSuffix(".cloudflareaccess.com") ||
        path == "/cdn-cgi/access" || path.hasPrefix("/cdn-cgi/access/")
    }
}

// MARK: - Bridge

public struct WebShellResourceRef: Equatable, Sendable {
    public let kind: String
    public let source: String
    public let account: String
    public let resource: String
    public let version: String
    public let audience: String
}

public enum WebShellCommand: Equatable, Sendable {
    case download(WebShellResourceRef)
    case offlineSave(WebShellResourceRef)
    case offlineRemove(offlineId: String)
    case offlineList
    case offlineOpen(offlineId: String)

    public var capability: String {
        if case .download = self { return "download" }
        return "offline"
    }
    /// Commands that change what is stored on the device need native confirmation.
    public var mutates: Bool {
        switch self {
        case .download, .offlineSave, .offlineRemove: return true
        case .offlineList, .offlineOpen: return false
        }
    }
}

public enum WebShellReceiptCode: String, Sendable {
    case denied, cancelled, unsupported, notFound = "not_found", unavailable
    case rateLimited = "rate_limited", needsConfirmation = "needs_confirmation"
}

public struct WebShellRequest: Equatable, Sendable {
    public let requestId: String
    public let command: WebShellCommand
}

/// The only shape ever returned to page script: no server text, no paths, no credentials.
public struct WebShellReceipt: Equatable, Sendable {
    public let requestId: String
    public let code: WebShellReceiptCode?
    public var ok: Bool { code == nil }
    public var json: [String: any Sendable] {
        if let code { return ["ok": false, "requestId": requestId, "code": code.rawValue] }
        return ["ok": true, "requestId": requestId, "state": "done"]
    }
    public static func failure(_ requestId: String, _ code: WebShellReceiptCode) -> WebShellReceipt {
        WebShellReceipt(requestId: requestId, code: code)
    }
}

/// Fixed-window limit on bridge requests from one page.
public struct WebShellRateLimiter: Sendable {
    public let limit: Int
    public let window: TimeInterval
    private var windowStart: Date?
    private var count = 0
    public init(limit: Int = 30, window: TimeInterval = 10) { self.limit = limit; self.window = window }
    public mutating func admit(now: Date = Date()) -> Bool {
        if let start = windowStart, now.timeIntervalSince(start) >= 0, now.timeIntervalSince(start) < window {
            guard count < limit else { return false }
            count += 1
            return true
        }
        windowStart = now
        count = 1
        return limit > 0
    }
}

public enum WebShellBridge {
    public static let version = 1
    public static let handlerName = "ltdsApp"
    /// Commands this build can actually perform. Empty until download and offline storage exist.
    public static let supportedCapabilities: Set<String> = []

    /// Strictly parses a page message. Unknown or extra fields are rejected.
    public static func parse(_ body: Any) -> WebShellRequest? {
        guard let message = body as? [String: Any], Set(message.keys) == ["requestId", "command"],
              let requestId = message["requestId"] as? String, token(requestId, max: 64),
              let raw = message["command"] as? [String: Any], let type = raw["type"] as? String else { return nil }
        let keys = Set(raw.keys)
        let command: WebShellCommand
        switch type {
        case "download":
            guard keys == ["type", "ref"], let ref = resourceRef(raw["ref"]) else { return nil }
            command = .download(ref)
        case "offline.save":
            guard keys == ["type", "ref"], let ref = resourceRef(raw["ref"]) else { return nil }
            command = .offlineSave(ref)
        case "offline.remove":
            guard keys == ["type", "ref"], let id = offlineId(raw["ref"]) else { return nil }
            command = .offlineRemove(offlineId: id)
        case "offline.open":
            guard keys == ["type", "ref"], let id = offlineId(raw["ref"]) else { return nil }
            command = .offlineOpen(offlineId: id)
        case "offline.list":
            guard keys == ["type"] else { return nil }
            command = .offlineList
        default: return nil
        }
        return WebShellRequest(requestId: requestId, command: command)
    }

    /// The request id to echo for a message that failed strict parsing, when it is safe to echo.
    public static func requestId(of body: Any) -> String {
        guard let message = body as? [String: Any], let id = message["requestId"] as? String, token(id, max: 64) else { return "invalid" }
        return id
    }

    /// Decides the receipt for a page message. `confirmed` is native evidence only; the page cannot supply it.
    public static func respond(to body: Any, capabilities: Set<String>, limiter: inout WebShellRateLimiter,
                               now: Date = Date(), confirmed: Bool = false) -> WebShellReceipt {
        let fallbackId = requestId(of: body)
        guard limiter.admit(now: now) else { return .failure(fallbackId, .rateLimited) }
        guard let request = parse(body) else { return .failure(fallbackId, .unsupported) }
        guard capabilities.contains(request.command.capability),
              supportedCapabilities.contains(request.command.capability) else { return .failure(request.requestId, .unsupported) }
        if request.command.mutates && !confirmed { return .failure(request.requestId, .needsConfirmation) }
        // No command is implemented natively yet; never report success for work that did not happen.
        return .failure(request.requestId, .unavailable)
    }

    /// Script installed at document start in allowlisted main frames only.
    public static func bootstrapScript(capabilities: Set<String>) -> String {
        let list = capabilities.filter { token($0, max: 32) }.sorted().map { "\"\($0)\"" }.joined(separator: ",")
        return """
        (() => {
          if (window.top !== window || window.\(handlerName)) return;
          const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
          if (!handler) return;
          const listeners = new Set();
          let counter = 0;
          const api = Object.freeze({
            version: \(version),
            platform: "ios",
            capabilities: Object.freeze([\(list)]),
            request(command) {
              const requestId = "r" + Date.now().toString(36) + "-" + (++counter).toString(36);
              return handler.postMessage({ requestId, command }).then(
                (receipt) => receipt,
                () => ({ ok: false, requestId, code: "unavailable" }));
            },
            onEvent(listener) {
              if (typeof listener !== "function") return () => {};
              listeners.add(listener);
              return () => { listeners.delete(listener); };
            }
          });
          Object.defineProperty(window, "\(handlerName)", { value: api, writable: false, configurable: false, enumerable: false });
        })();
        """
    }

    private static func resourceRef(_ value: Any?) -> WebShellResourceRef? {
        guard let raw = value as? [String: Any],
              Set(raw.keys) == ["kind", "source", "account", "resource", "version", "audience"],
              let kind = raw["kind"] as? String, ["delivery-file", "viewer-model"].contains(kind),
              let source = raw["source"] as? String, token(source, max: 128),
              let account = raw["account"] as? String, token(account, max: 128),
              let resource = raw["resource"] as? String, token(resource, max: 128),
              let version = raw["version"] as? String, token(version, max: 128),
              let audience = raw["audience"] as? String, ["ops", "client"].contains(audience) else { return nil }
        return WebShellResourceRef(kind: kind, source: source, account: account, resource: resource, version: version, audience: audience)
    }

    private static func offlineId(_ value: Any?) -> String? {
        guard let raw = value as? [String: Any], Set(raw.keys) == ["offlineId"],
              let id = raw["offlineId"] as? String, token(id, max: 128) else { return nil }
        return id
    }

    /// `[A-Za-z0-9:_-]`, non-empty, bounded.
    static func token(_ text: String, max: Int) -> Bool {
        !text.isEmpty && text.utf8.count <= max && text.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 58 || $0 == 95 || $0 == 45
        }
    }
}
