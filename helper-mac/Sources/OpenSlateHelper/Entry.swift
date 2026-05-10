// main.swift
//
// openslate-helper — a small CLI daemon that streams the global cursor
// position over a WebSocket on 127.0.0.1, so a browser tab using
// getDisplayMedia (which can't see global cursor coords) can render a
// polished cursor sprite at the recorded positions.
//
// Usage:
//   openslate-helper [--port N]
//
// Wire protocol (text frames, line-delimited JSON):
//   client  → server   {"cmd":"start"}
//   server  → client   {"type":"started","screen_w":1920,"screen_h":1080,"scale":2,
//                       "accessibility":true|false}
//   server  → client   {"type":"cursor","t_ms":17,"x":824.5,"y":412.3,"kind":"arrow"}
//                      ... ~125 Hz while running
//   server  → client   {"type":"click","t_ms":523,"x":824.5,"y":412.3,"kind":"left"}
//                      (only when Accessibility permission has been granted)
//   client  → server   {"cmd":"stop"}
//   client  → server   {"cmd":"start"}        // can re-arm
//
// Cursor + display polling work without any TCC permissions. The
// Accessibility permission is requested only if the host needs real
// click events (vs the heuristic the recorder server can derive from
// the cursor track).

import AppKit
import Foundation

@MainActor
final class HelperApp {
    let server: WSServer
    let tracker = CursorTracker()
    let clickTap = ClickTap()
    var streaming = false

    init(port: UInt16) {
        self.server = WSServer(port: port)
    }

    func run() throws {
        server.onConnect = { [weak self] in
            FileHandle.standardError.write(
                Data("openslate-helper: client connected\n".utf8))
            self?.streaming = false
        }
        server.onDisconnect = { [weak self] in
            FileHandle.standardError.write(
                Data("openslate-helper: client disconnected\n".utf8))
            self?.streaming = false
            self?.tracker.stop()
        }
        server.onMessage = { [weak self] text in
            self?.handleCommand(text)
        }
        try server.start()
        FileHandle.standardError.write(
            Data("openslate-helper: listening on 127.0.0.1:\(server.portNumber)\n".utf8))
    }

    func handleCommand(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cmd = obj["cmd"] as? String
        else {
            return
        }
        switch cmd {
        case "start":
            startStreaming()
        case "stop":
            stopStreaming()
        default:
            break
        }
    }

    private func startStreaming() {
        if streaming { return }
        streaming = true
        tracker.start(sampleRateHz: 125) { [weak self] sample in
            guard let self = self, self.streaming else { return }
            let json =
                "{\"type\":\"cursor\","
                + "\"t_ms\":\(sample.tMs),"
                + "\"x\":\(formatNumber(sample.x)),"
                + "\"y\":\(formatNumber(sample.y)),"
                + "\"kind\":\"\(sample.kind)\"}"
            self.server.send(json)
        }
        // Click tap requires Accessibility permission. If we have it,
        // start it on the same monotonic epoch as the cursor tracker
        // so timestamps line up. If not, the recorder server falls
        // back to the cursor-track heuristic.
        let hasAX = ClickTap.hasAccessibilityPermission()
        if hasAX {
            clickTap.start(
                startMonotonicNs: tracker.startedMonotonicNs,
                primaryHeightPoints: tracker.primaryHeightPoints,
                primaryScale: tracker.primaryScale,
                onClick: { [weak self] click in
                    guard let self = self, self.streaming else { return }
                    let json =
                        "{\"type\":\"click\","
                        + "\"t_ms\":\(click.tMs),"
                        + "\"x\":\(formatNumber(click.x)),"
                        + "\"y\":\(formatNumber(click.y)),"
                        + "\"kind\":\"\(click.kind)\"}"
                    self.server.send(json)
                }
            )
        }

        let info = tracker.display
        let started =
            "{\"type\":\"started\","
            + "\"screen_w\":\(info.widthPixels),"
            + "\"screen_h\":\(info.heightPixels),"
            + "\"scale\":\(info.scale),"
            + "\"accessibility\":\(hasAX ? "true" : "false")}"
        server.send(started)
    }

    private func stopStreaming() {
        streaming = false
        tracker.stop()
        clickTap.stop()
    }
}

// Trim trailing zeros so {"x":824.0} becomes {"x":824} but precision is
// kept where it matters. JSONSerialization is overkill for this hot path.
func formatNumber(_ d: Double) -> String {
    if d == d.rounded() {
        return String(Int(d))
    }
    return String(format: "%.2f", d)
}

// ── entry ─────────────────────────────────────────────────────────────

@main
@MainActor
struct Entry {
    static func main() {
        let port = parsePort(CommandLine.arguments)
        let app = HelperApp(port: port)
        do {
            try app.run()
        } catch {
            FileHandle.standardError.write(
                Data("openslate-helper: failed to start: \(error)\n".utf8))
            exit(1)
        }

        // SIGINT (Ctrl+C) tears down cleanly.
        signal(SIGINT, SIG_IGN)
        let sigintSrc = DispatchSource.makeSignalSource(
            signal: SIGINT, queue: .main)
        sigintSrc.setEventHandler {
            FileHandle.standardError.write(Data("openslate-helper: stopping\n".utf8))
            exit(0)
        }
        sigintSrc.resume()

        // Drives GCD timers + Network.framework events on the main queue.
        RunLoop.main.run()
    }

    static func parsePort(_ args: [String]) -> UInt16 {
        var i = 1
        while i < args.count {
            if args[i] == "--port", i + 1 < args.count, let n = UInt16(args[i + 1]) {
                return n
            }
            i += 1
        }
        return 9292  // default; openslate-helper is the only thing that should use it
    }
}
