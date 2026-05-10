// CursorTracker.swift
//
// Polls the global mouse cursor position. Reads `NSEvent.mouseLocation`
// (a public Cocoa API that returns the system cursor position in
// AppKit screen coordinates — bottom-left origin). No TCC entitlements
// required; no event tap; safe to run as a background CLI.
//
// We convert to top-left-origin screen pixels because every other
// system openSlate touches (browser getDisplayMedia output, Remotion,
// ffmpeg, image inspectors) uses top-left.

import AppKit
import Foundation

struct CursorSample {
    /// Milliseconds since the tracker was started. Sender attaches a
    /// shared epoch when communicating with the browser, so the JS side
    /// can align cursor events to the recording timeline.
    let tMs: Int
    /// Screen-absolute pixel coordinates, top-left origin.
    let x: Double
    let y: Double
}

/// Snapshot of the primary display geometry. Matches what the browser
/// will see if the user shares their primary monitor in getDisplayMedia
/// (which is the assumption for the v1 MVP — multi-display support is a
/// future iteration).
struct DisplayInfo {
    let widthPoints: Int
    let heightPoints: Int
    let scale: Double
    var widthPixels: Int { Int(Double(widthPoints) * scale) }
    var heightPixels: Int { Int(Double(heightPoints) * scale) }
}

@MainActor
final class CursorTracker {
    private var startMonotonicNs: UInt64 = 0
    private var timer: DispatchSourceTimer?
    private var onSample: ((CursorSample) -> Void)?

    /// Display geometry sampled at start time. Reported to the client
    /// so it can convert helper coords into capture-relative coords if
    /// needed.
    private(set) var display: DisplayInfo = DisplayInfo(
        widthPoints: 0, heightPoints: 0, scale: 1.0
    )

    /// Begin polling at the given sample rate. Calls `onSample` for
    /// each sample on the main queue.
    func start(sampleRateHz: Int = 125, onSample: @escaping (CursorSample) -> Void) {
        stop()
        self.onSample = onSample
        self.startMonotonicNs = monotonicNs()
        self.display = primaryDisplay()

        // GCD timer with a strict-ish leeway. The whole budget per
        // sample is < 100 µs (one Cocoa class-method call + a JSON
        // encode + write to the WebSocket), so 125 Hz is comfortable.
        let interval = 1.0 / Double(sampleRateHz)
        let q = DispatchQueue.main
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(
            deadline: .now() + interval,
            repeating: interval,
            leeway: .milliseconds(2)
        )
        t.setEventHandler { [weak self] in
            guard let self = self, let cb = self.onSample else { return }
            cb(self.sampleNow())
        }
        t.resume()
        self.timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func sampleNow() -> CursorSample {
        // NSEvent.mouseLocation returns AppKit screen coords:
        //   - origin at the BOTTOM-LEFT of the primary screen
        //   - Y increases upward
        // Convert to top-left-origin pixels.
        let appkit = NSEvent.mouseLocation
        let h = Double(display.heightPoints)
        let topLeftX = appkit.x
        let topLeftY = h - appkit.y

        // Convert points → pixels. On Retina displays the captured
        // video is in pixels; reporting in pixels keeps clients from
        // having to know the scale factor.
        let scale = display.scale
        let xPx = topLeftX * scale
        let yPx = topLeftY * scale

        let elapsedMs = Int((monotonicNs() &- startMonotonicNs) / 1_000_000)
        return CursorSample(tMs: elapsedMs, x: xPx, y: yPx)
    }

    // MARK: - helpers

    private func primaryDisplay() -> DisplayInfo {
        // NSScreen.main is the screen with the menu bar — what
        // getDisplayMedia returns by default when the user picks
        // "Entire screen". `.screens.first` is the same on most setups
        // but more reliable when the helper is launched from a context
        // that doesn't have a "key" screen yet.
        guard let screen = NSScreen.main ?? NSScreen.screens.first else {
            return DisplayInfo(widthPoints: 0, heightPoints: 0, scale: 1.0)
        }
        return DisplayInfo(
            widthPoints: Int(screen.frame.width),
            heightPoints: Int(screen.frame.height),
            scale: Double(screen.backingScaleFactor)
        )
    }

    private func monotonicNs() -> UInt64 {
        // mach_absolute_time on macOS; clock_gettime(CLOCK_MONOTONIC)
        // would also work. ContinuousClock isn't available pre-macOS 13.
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let raw = mach_absolute_time()
        // Convert ticks → ns. info.numer / info.denom is 1/1 on x86_64,
        // 125/3 on Apple Silicon — the math matters either way.
        return raw &* UInt64(info.numer) / UInt64(info.denom)
    }
}
