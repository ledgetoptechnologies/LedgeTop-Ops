import XCTest
@testable import LTOpsCore

final class ManagedPilotBuildConfigurationTests: XCTestCase {
    func testStagingDiagnosticAndReadsHaveFixedResource() throws {
        let probe = try XCTUnwrap(ManagedPilotBuildConfiguration.selected(
            live: false, probe: true, environment: "staging"))
        let reads = try XCTUnwrap(ManagedPilotBuildConfiguration.selected(
            live: true, probe: false, environment: "staging"))
        XCTAssertTrue(probe.synthetic)
        XCTAssertFalse(reads.synthetic)
        XCTAssertEqual(probe.environment, .staging)
        XCTAssertEqual(probe.pins.resource, "https://ios-pilot-staging.ledgetop.app")
        XCTAssertEqual(reads.pins.resource, probe.pins.resource)
    }

    func testProductionRequiresDedicatedBuildOptInAndNeverUsesStagingResource() throws {
        XCTAssertNil(ManagedPilotBuildConfiguration.selected(
            live: true, probe: false, environment: "production"))
        let reads = try XCTUnwrap(ManagedPilotBuildConfiguration.selected(
            live: true, probe: false, environment: "production", productionEnabled: true))
        XCTAssertFalse(reads.synthetic)
        XCTAssertEqual(reads.environment, .production)
        XCTAssertEqual(reads.pins.resource, "https://ios-pilot.ledgetop.app")
        XCTAssertEqual(reads.pins.issuer, "https://ledgetoptechnologies.cloudflareaccess.com")
        for endpoint in [reads.pins.authorizationEndpoint, reads.pins.tokenEndpoint,
                         reads.pins.registrationEndpoint, reads.pins.revocationEndpoint] {
            XCTAssertTrue(endpoint.hasPrefix(reads.pins.issuer + "/cdn-cgi/access/oauth/"))
        }
    }

    func testMixedAndInactiveModesDoNotConfigureNetworking() {
        for environment in ["staging", "production"] {
            for production in [false, true] {
                XCTAssertNil(ManagedPilotBuildConfiguration.selected(
                    live: true, probe: true, environment: environment, productionEnabled: production))
                XCTAssertNil(ManagedPilotBuildConfiguration.selected(
                    live: false, probe: false, environment: environment, productionEnabled: production))
            }
        }
        XCTAssertNil(ManagedPilotBuildConfiguration.selected(
            live: false, probe: true, environment: "production", productionEnabled: true))
        XCTAssertNil(ManagedPilotBuildConfiguration.selected(
            live: true, probe: false, environment: "staging", productionEnabled: true))
    }

    func testUnknownEnvironmentCannotSupplyAnOriginOrFallBackToStaging() {
        for environment in ["", "Production", " production", "production ",
                            "https://ios-pilot.ledgetop.app", "https://attacker.example"] {
            XCTAssertNil(ManagedPilotBuildConfiguration.selected(
                live: true, probe: false, environment: environment, productionEnabled: true))
        }
    }
}
