// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LTOpsPilot",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "LTOpsPilot", targets: ["LTOpsPilot"])],
    targets: [
        .target(name: "LTOpsCore"),
        .target(name: "LTOpsPilot", dependencies: ["LTOpsCore"]),
        .testTarget(name: "LTOpsCoreTests", dependencies: ["LTOpsCore"])
    ]
)
