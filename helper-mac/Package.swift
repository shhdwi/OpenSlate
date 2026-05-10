// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "OpenSlateHelper",
    platforms: [
        // 10.15 brings Network.framework's NWProtocolWebSocket which we
        // use to skip writing a hand-rolled WebSocket framer. Anything
        // older isn't realistic for this audience anyway.
        .macOS(.v10_15)
    ],
    products: [
        .executable(name: "openslate-helper", targets: ["OpenSlateHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "OpenSlateHelper",
            // No dependencies. Just AppKit + Network.framework, both in the SDK.
            path: "Sources/OpenSlateHelper"
        ),
    ]
)
