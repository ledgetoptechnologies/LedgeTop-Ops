import Foundation

/// Isolated provider experiment. This must only receive a freshly authorized
/// synthetic grant; all credentials remain in memory and are cleaned up.
public enum SyntheticRefreshObservation: Sendable, Equatable {
    case rotatedReplayRejectedCurrentRejected
    case rotatedReplayRejectedCurrentAccepted
    case replayAccepted
    case notRotated
    case inconclusive
}
public struct SyntheticRefreshReport: Sendable, Equatable {
    public let observation: SyntheticRefreshObservation
    public let cleanupUnconfirmed: Bool
    public init(observation: SyntheticRefreshObservation, cleanupUnconfirmed: Bool) {
        self.observation = observation; self.cleanupUnconfirmed = cleanupUnconfirmed
    }
}

public protocol SyntheticRefreshTransport: Sendable {
    /// Must not substitute the previous refresh token when the provider omits it.
    func strictRefresh(token: String, clientID: String) async throws -> ManagedOAuthCredential
    func revoke(token: String, clientID: String, hint: ManagedOAuthTokenKind) async throws
}

public enum SyntheticRefreshExperiment {
    public static let resource = "https://ios-pilot-staging.ledgetop.app"
    public static func run(pins: ManagedOAuthPins, credential: ManagedOAuthCredential, clientID: String,
                           transport: any SyntheticRefreshTransport) async -> SyntheticRefreshReport {
        let issuer = "https://ledgetoptechnologies.cloudflareaccess.com"
        guard pins.resource == resource, pins.issuer == issuer,
              pins.tokenEndpoint == issuer + "/cdn-cgi/access/oauth/token",
              pins.revocationEndpoint == issuer + "/cdn-cgi/access/oauth/revoke" else {
            return SyntheticRefreshReport(observation: .inconclusive, cleanupUnconfirmed: true)
        }
        var issued = [credential]
        var observation: SyntheticRefreshObservation = .inconclusive
        var lostResponsePossible = false
        do {
            try Task.checkCancellation()
            guard credential.expiresAt > Date(), let r0 = credential.refreshToken else { throw MobilePilotError.invalidResponse }
            let first = try await transport.strictRefresh(token: r0, clientID: clientID)
            issued.append(first)
            guard let r1 = first.refreshToken, first.expiresAt > Date() else { throw MobilePilotError.invalidResponse }
            if r1 == r0 { observation = .notRotated }
            else {
                try Task.checkCancellation()
                let second = try await transport.strictRefresh(token: r1, clientID: clientID)
                issued.append(second)
                guard let r2 = second.refreshToken, second.expiresAt > Date() else { throw MobilePilotError.invalidResponse }
                if r2 == r1 || r2 == r0 { observation = .notRotated }
                else {
                    try Task.checkCancellation()
                    var replayDenied = false
                    do {
                        let replay = try await transport.strictRefresh(token: r1, clientID: clientID)
                        issued.append(replay)
                        observation = .replayAccepted
                    } catch ManagedOAuthRevocationFailure.httpStatus(400) { replayDenied = true }
                    catch { throw error }
                    if replayDenied {
                        try Task.checkCancellation()
                        do {
                            let current = try await transport.strictRefresh(token: r2, clientID: clientID)
                            issued.append(current)
                            observation = .rotatedReplayRejectedCurrentAccepted
                        } catch ManagedOAuthRevocationFailure.httpStatus(400) {
                            observation = .rotatedReplayRejectedCurrentRejected
                        } catch { throw error }
                    }
                }
            }
        } catch { observation = .inconclusive; lostResponsePossible = true }
        // Ensure cancellation cannot skip cleanup. Rejections or lost responses
        // do not prove a grant was revoked, so report uncertainty conservatively.
        let captured = issued
        let cleanupUnconfirmed = await Task.detached {
            var refreshes = Set<String>(), accesses = Set<String>(), failed = false
            for item in captured {
                if let refresh = item.refreshToken { refreshes.insert(refresh) }
                accesses.insert(item.accessToken)
            }
            for token in refreshes { do { try await transport.revoke(token: token, clientID: clientID, hint: .refresh) } catch { failed = true } }
            for token in accesses { do { try await transport.revoke(token: token, clientID: clientID, hint: .access) } catch { failed = true } }
            return failed
        }.value
        return SyntheticRefreshReport(observation: observation, cleanupUnconfirmed: cleanupUnconfirmed || lostResponsePossible)
    }
}
