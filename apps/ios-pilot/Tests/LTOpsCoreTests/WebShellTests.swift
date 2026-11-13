import XCTest
@testable import LTOpsCore

final class WebShellTests: XCTestCase {
    private func policy(_ origins: [String] = ["https://ops.example.com"]) -> WebShellNavigationPolicy {
        WebShellNavigationPolicy(configuration: WebShellConfiguration(origins: origins)!)
    }
    private func url(_ text: String) -> URL { URL(string: text)! }

    func testConfiguredOriginsMustBeExactHttpsNames() {
        XCTAssertNotNil(WebShellOrigin(configured: "https://ops.example.com"))
        XCTAssertNotNil(WebShellOrigin(configured: "https://ops.example.com/"))
        XCTAssertEqual(WebShellOrigin(configured: "https://ops.example.com:8443")?.port, 8443)
        for bad in ["http://ops.example.com", "https://*.example.com", "https://ops.example.com/app",
                    "https://user@ops.example.com", "https://ops.example.com?x=1", "https://ops.example.com#x",
                    "https://localhost", "https://app.localhost", "https://printer.local", "https://127.0.0.1",
                    "https://10.0.0.5:8443", "https://[::1]", "https://OPS.example.com", "https://example",
                    "https://ops.example.com:443", "https://ops..example.com", "https://-ops.example.com",
                    "ops.example.com", "", "file:///index.html", "javascript:alert(1)"] {
            XCTAssertNil(WebShellOrigin(configured: bad), bad)
        }
    }

    func testConfigurationFailsClosedOnAnyInvalidEntryOrStartPath() {
        XCTAssertNil(WebShellConfiguration(origins: []))
        XCTAssertNil(WebShellConfiguration(origins: ["https://ops.example.com", "https://*.example.com"]))
        XCTAssertNil(WebShellConfiguration(origins: ["https://ops.example.com", "https://ops.example.com/"]))
        XCTAssertNil(WebShellConfiguration(origins: Array(repeating: "https://ops.example.com", count: 9)))
        for bad in ["", "home", "//evil.example.com", "/a?b=1", "/a#b", "/a/../b", "/a b", "/\\evil.example.com"] {
            XCTAssertNil(WebShellConfiguration(origins: ["https://ops.example.com"], startPath: bad), bad)
        }
        let config = WebShellConfiguration(origins: ["https://ops.example.com", "https://portal.example.com"], startPath: "/today")
        XCTAssertEqual(config?.start.absoluteString, "https://ops.example.com/today")
        XCTAssertEqual(config?.origins.count, 2)
    }

    func testBuildSettingsAreOffUnlessExplicitlyEnabledAndValid() {
        let origins = ["https://ops.example.com"]
        XCTAssertNil(WebShellConfiguration.fromInfo(nil))
        XCTAssertNil(WebShellConfiguration.fromInfo([:]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellOrigins": origins]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": false, "LTOpsWebShellOrigins": origins]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": "true", "LTOpsWebShellOrigins": origins]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": true]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": true, "LTOpsWebShellOrigins": [String]()]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": true, "LTOpsWebShellOrigins": "https://ops.example.com"]))
        XCTAssertNil(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": true, "LTOpsWebShellOrigins": origins, "LTOpsWebShellStartPath": 7]))
        XCTAssertEqual(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": true, "LTOpsWebShellOrigins": origins])?.start.absoluteString,
                       "https://ops.example.com/")
        XCTAssertEqual(WebShellConfiguration.fromInfo(["LTOpsWebShellEnabled": true, "LTOpsWebShellOrigins": origins,
                                                       "LTOpsWebShellStartPath": "/today"])?.start.absoluteString, "https://ops.example.com/today")
        XCTAssertTrue(WebShellConfiguration.isEnabled(["LTOpsWebShellEnabled": true]))
        XCTAssertFalse(WebShellConfiguration.isEnabled(["LTOpsWebShellEnabled": "true"]))
    }

    func testMainFrameStaysOnAllowlistedOrigins() {
        let policy = policy()
        XCTAssertEqual(policy.decide(url: url("https://ops.example.com/clients?id=4"), isMainFrame: true, userInitiated: false), .allow)
        let other = url("https://elsewhere.example.org/page")
        XCTAssertEqual(policy.decide(url: other, isMainFrame: true, userInitiated: true), .external(other))
        XCTAssertEqual(policy.decide(url: other, isMainFrame: true, userInitiated: false), .cancel)
        // Look-alike hosts and ports are different origins.
        for near in ["https://ops.example.com.evil.org/", "https://evil-ops.example.com/", "https://ops.example.com:8443/",
                     "https://ops.example.com@evil.org/", "http://ops.example.com/"] {
            XCTAssertNotEqual(policy.decide(url: url(near), isMainFrame: true, userInitiated: false), .allow, near)
        }
        XCTAssertEqual(policy.decide(url: nil, isMainFrame: true, userInitiated: true), .cancel)
    }

    func testUnsafeSchemesNeverLoad() {
        let policy = policy()
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<p>x</p>", "ftp://ops.example.com/x",
                    "blob:https://ops.example.com/1234", "customscheme://open"] {
            XCTAssertEqual(policy.decide(url: url(bad), isMainFrame: true, userInitiated: true), .cancel, bad)
        }
        let mail = url("mailto:someone@example.com")
        XCTAssertEqual(policy.decide(url: mail, isMainFrame: true, userInitiated: true), .external(mail))
        XCTAssertEqual(policy.decide(url: mail, isMainFrame: true, userInitiated: false), .cancel)
        XCTAssertEqual(policy.decide(url: url("about:blank"), isMainFrame: true, userInitiated: false), .allow)
        XCTAssertEqual(policy.decide(url: url("blob:https://ops.example.com/1234"), isMainFrame: false, userInitiated: false), .allow)
        XCTAssertEqual(policy.decide(url: url("data:text/html,x"), isMainFrame: false, userInitiated: false), .cancel)
        XCTAssertEqual(policy.decide(url: url("https://maps.example.net/embed"), isMainFrame: false, userInitiated: false), .allow)
    }

    func testSignInPagesAreNeverShownInTheWebView() {
        let policy = policy()
        for signIn in ["https://team.cloudflareaccess.com/cdn-cgi/access/login/ops.example.com?kid=1",
                       "https://ops.example.com/cdn-cgi/access/authorized?nonce=1",
                       "https://ops.example.com/cdn-cgi/access/logout"] {
            XCTAssertEqual(policy.decide(url: url(signIn), isMainFrame: true, userInitiated: false), .nativeSignIn, signIn)
            XCTAssertEqual(policy.decide(url: url(signIn), isMainFrame: false, userInitiated: false), .cancel, signIn)
        }
        XCTAssertEqual(policy.decide(url: url("https://ops.example.com/cdn-cgi/accessible"), isMainFrame: true, userInitiated: false), .allow)
        XCTAssertNotEqual(policy.decide(url: url("https://notcloudflareaccess.com/"), isMainFrame: true, userInitiated: false), .nativeSignIn)
    }

    private let ref: [String: Any] = ["kind": "delivery-file", "source": "project-alpha:primary", "account": "org_1",
                                      "resource": "file-9", "version": "v3", "audience": "ops"]

    func testParsesEveryCommandShape() {
        XCTAssertEqual(WebShellBridge.parse(["requestId": "r1", "command": ["type": "download", "ref": ref]])?.command,
                       .download(WebShellResourceRef(kind: "delivery-file", source: "project-alpha:primary", account: "org_1",
                                                     resource: "file-9", version: "v3", audience: "ops")))
        if case .offlineSave = WebShellBridge.parse(["requestId": "r2", "command": ["type": "offline.save", "ref": ref]])?.command {} else { XCTFail() }
        XCTAssertEqual(WebShellBridge.parse(["requestId": "r3", "command": ["type": "offline.remove", "ref": ["offlineId": "o-1"]]])?.command,
                       .offlineRemove(offlineId: "o-1"))
        XCTAssertEqual(WebShellBridge.parse(["requestId": "r4", "command": ["type": "offline.open", "ref": ["offlineId": "o-1"]]])?.command,
                       .offlineOpen(offlineId: "o-1"))
        XCTAssertEqual(WebShellBridge.parse(["requestId": "r5", "command": ["type": "offline.list"]])?.command, .offlineList)
    }

    func testRejectsUnknownExtraOversizedAndPathLikeFields() {
        var extra = ref; extra["url"] = "https://evil.example.org/x"
        var path = ref; path["resource"] = "../../etc/passwd"
        var long = ref; long["account"] = String(repeating: "a", count: 129)
        var kind = ref; kind["kind"] = "anything"
        var audience = ref; audience["audience"] = "admin"
        var missing = ref; missing.removeValue(forKey: "version")
        let bad: [Any] = [
            "download", 7, [String: Any](),
            ["requestId": "r1"],
            ["requestId": "r1", "command": ["type": "download", "ref": ref], "userGesture": true],
            ["requestId": "r1", "command": ["type": "download", "ref": ref, "path": "/tmp/x"]],
            ["requestId": "r 1", "command": ["type": "offline.list"]],
            ["requestId": String(repeating: "r", count: 65), "command": ["type": "offline.list"]],
            ["requestId": "r1", "command": ["type": "offline.list", "ref": ref]],
            ["requestId": "r1", "command": ["type": "shell.exec"]],
            ["requestId": "r1", "command": ["type": "download", "ref": extra]],
            ["requestId": "r1", "command": ["type": "download", "ref": path]],
            ["requestId": "r1", "command": ["type": "download", "ref": long]],
            ["requestId": "r1", "command": ["type": "download", "ref": kind]],
            ["requestId": "r1", "command": ["type": "download", "ref": audience]],
            ["requestId": "r1", "command": ["type": "download", "ref": missing]],
            ["requestId": "r1", "command": ["type": "offline.remove", "ref": ["offlineId": "o/1"]]],
            ["requestId": "r1", "command": ["type": "offline.open", "ref": ["offlineId": "o-1", "x": 1]]],
        ]
        for message in bad { XCTAssertNil(WebShellBridge.parse(message), "\(message)") }
    }

    func testReceiptsNeverClaimSuccessAndEchoOnlySafeIds() {
        var limiter = WebShellRateLimiter()
        let download: [String: Any] = ["requestId": "r1", "command": ["type": "download", "ref": ref]]
        // This build supports no capability, whatever the page was told.
        for capabilities in [Set<String>(), ["download"], ["download", "offline"]] {
            let receipt = WebShellBridge.respond(to: download, capabilities: capabilities, limiter: &limiter)
            XCTAssertEqual(receipt, .failure("r1", .unsupported))
            XCTAssertFalse(receipt.ok)
        }
        XCTAssertEqual(WebShellBridge.respond(to: ["requestId": "<script>", "command": 1], capabilities: [], limiter: &limiter),
                       .failure("invalid", .unsupported))
        XCTAssertEqual(WebShellBridge.respond(to: "junk", capabilities: [], limiter: &limiter).requestId, "invalid")
        let json = WebShellReceipt.failure("r9", .needsConfirmation).json
        XCTAssertEqual(json["ok"] as? Bool, false)
        XCTAssertEqual(json["code"] as? String, "needs_confirmation")
        XCTAssertEqual(Set(json.keys), ["ok", "requestId", "code"])
        XCTAssertTrue(WebShellBridge.supportedCapabilities.isEmpty)
    }

    func testCommandMetadata() {
        let item = WebShellResourceRef(kind: "viewer-model", source: "s", account: "a", resource: "r", version: "v", audience: "client")
        XCTAssertEqual(WebShellCommand.download(item).capability, "download")
        XCTAssertEqual(WebShellCommand.offlineList.capability, "offline")
        XCTAssertTrue(WebShellCommand.download(item).mutates)
        XCTAssertTrue(WebShellCommand.offlineSave(item).mutates)
        XCTAssertTrue(WebShellCommand.offlineRemove(offlineId: "o").mutates)
        XCTAssertFalse(WebShellCommand.offlineList.mutates)
        XCTAssertFalse(WebShellCommand.offlineOpen(offlineId: "o").mutates)
    }

    func testRateLimitIsPerWindow() {
        var limiter = WebShellRateLimiter(limit: 2, window: 10)
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(limiter.admit(now: start))
        XCTAssertTrue(limiter.admit(now: start.addingTimeInterval(1)))
        XCTAssertFalse(limiter.admit(now: start.addingTimeInterval(9)))
        XCTAssertTrue(limiter.admit(now: start.addingTimeInterval(10)))
        var limited = WebShellRateLimiter(limit: 1, window: 10)
        let list: [String: Any] = ["requestId": "r1", "command": ["type": "offline.list"]]
        _ = WebShellBridge.respond(to: list, capabilities: [], limiter: &limited, now: start)
        XCTAssertEqual(WebShellBridge.respond(to: list, capabilities: [], limiter: &limited, now: start), .failure("r1", .rateLimited))
        var none = WebShellRateLimiter(limit: 0, window: 10)
        XCTAssertFalse(none.admit(now: start))
    }

    func testBootstrapScriptIsMainFrameOnlyAndCarriesNoSecrets() {
        let script = WebShellBridge.bootstrapScript(capabilities: ["offline", "download", "bad\"quote"])
        XCTAssertTrue(script.contains("window.top !== window"))
        XCTAssertTrue(script.contains("capabilities: Object.freeze([\"download\",\"offline\"])"))
        XCTAssertFalse(script.contains("bad"))
        XCTAssertTrue(script.contains("writable: false"))
        XCTAssertTrue(WebShellBridge.bootstrapScript(capabilities: []).contains("Object.freeze([])"))
    }
}
