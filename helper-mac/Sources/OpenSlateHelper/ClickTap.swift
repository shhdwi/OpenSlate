// ClickTap.swift
//
// Captures global mouse-down events via CGEventTap. Emits the click
// position + the cursor type at the moment of click. Requires the
// "Accessibility" TCC permission (System Settings → Privacy & Security
// → Accessibility); without it, CGEventTapCreate returns nil and the
// helper continues running with cursor-only data (heuristic click
// detection on the cursor track is the fallback).
//
// This is the only feature in the helper that needs a TCC permission;
// everything else (NSEvent.mouseLocation, NSCursor.current) is public
// API.

import AppKit
import CoreGraphics
import Foundation

struct ClickEvent {
    let tMs: Int
    let x: Double  // top-left-origin pixels
    let y: Double
    let kind: String  // "left", "right", "other"
}

@MainActor
final class ClickTap {
    private(set) var permitted: Bool = false
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    /// Set by `start(...)`; copied into events as `t_ms = nowMs - epoch`.
    private var startMonotonicNs: UInt64 = 0
    /// Convert AppKit-coordinate height to top-left coords.
    private var primaryHeightPoints: Double = 0
    private var primaryScale: Double = 1
    private var onClick: ((ClickEvent) -> Void)?

    /// Probe whether the process can post a tap. Returns false when
    /// Accessibility permission is denied — caller should surface this
    /// to the user with an actionable message.
    static func hasAccessibilityPermission() -> Bool {
        // Probe via AXIsProcessTrustedWithOptions; passing
        // kAXTrustedCheckOptionPrompt = false avoids the system prompt
        // here (we want to ask explicitly later, with context).
        let opts = ["AXTrustedCheckOptionPrompt": false] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    /// Triggers the macOS system prompt to add the helper to
    /// Accessibility. Returns true if we're trusted now (rare — the
    /// user usually has to grant + restart the helper).
    static func requestAccessibilityPermission() -> Bool {
        let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    func start(
        startMonotonicNs: UInt64,
        primaryHeightPoints: Double,
        primaryScale: Double,
        onClick: @escaping (ClickEvent) -> Void
    ) {
        stop()
        self.startMonotonicNs = startMonotonicNs
        self.primaryHeightPoints = primaryHeightPoints
        self.primaryScale = primaryScale
        self.onClick = onClick

        // Mask: left + right + other mouse-DOWN events. Listening only
        // (kCGTapOptionListenOnly) so we don't intercept user input.
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.otherMouseDown.rawValue)

        let userInfo = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: tapCallback,
            userInfo: userInfo
        ) else {
            permitted = false
            return
        }
        permitted = true
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.runLoopSource = src
    }

    func stop() {
        if let tap = tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let src = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), src, .commonModes)
        }
        tap = nil
        runLoopSource = nil
    }

    fileprivate func handle(event: CGEvent, type: CGEventType) {
        let p = event.location
        // CGEvent.location is already top-left-origin in points, so
        // unlike NSEvent.mouseLocation we don't have to flip Y. Convert
        // to pixels.
        let xPx = p.x * primaryScale
        let yPx = p.y * primaryScale

        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let nowNs = mach_absolute_time() &* UInt64(info.numer) / UInt64(info.denom)
        let elapsedMs = Int((nowNs &- startMonotonicNs) / 1_000_000)

        let kind: String
        switch type {
        case .leftMouseDown: kind = "left"
        case .rightMouseDown: kind = "right"
        default: kind = "other"
        }
        onClick?(ClickEvent(tMs: elapsedMs, x: xPx, y: yPx, kind: kind))
    }
}

/// Free C-callable callback. Re-enters the @MainActor instance via the
/// userInfo pointer.
private func tapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if let userInfo = userInfo {
        let me = Unmanaged<ClickTap>.fromOpaque(userInfo).takeUnretainedValue()
        DispatchQueue.main.async {
            me.handle(event: event, type: type)
        }
    }
    // Listen-only → return the event unchanged so user input flows.
    return Unmanaged.passUnretained(event)
}
