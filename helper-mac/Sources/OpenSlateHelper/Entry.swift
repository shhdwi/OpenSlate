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
//   server  → client   {"type":"started","screen_w":1920,"screen_h":1080,"scale":2}
//   server  → client   {"type":"cursor","t_ms":17,"x":824.5,"y":412.3}
//                      ... ~125 Hz while running
//   client  → server   {"cmd":"stop"}
//   client  → server   {"cmd":"start"}        // can re-arm
//
// No TCC permissions required. NSEvent.mouseLocation is a public API.

import AppKit
import Foundation

@MainActor
final class HelperApp {
    let server: WSServer
    let tracker = CursorTracker()
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
        // Capture display info before we hand the tracker a callback so
        // we can announce dimensions to the client first — useful for
        // the JS side to know the coordinate space.
        tracker.start(sampleRateHz: 125) { [weak self] sample in
            guard let self = self, self.streaming else { return }
            let json =
                "{\"type\":\"cursor\","
                + "\"t_ms\":\(sample.tMs),"
                + "\"x\":\(formatNumber(sample.x)),"
                + "\"y\":\(formatNumber(sample.y))}"
            self.server.send(json)
        }
        let info = tracker.display
        let started =
            "{\"type\":\"started\","
            + "\"screen_w\":\(info.widthPixels),"
            + "\"screen_h\":\(info.heightPixels),"
            + "\"scale\":\(info.scale)}"
        server.send(started)
    }

    private func stopStreaming() {
        streaming = false
        tracker.stop()
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
