# openslate-helper

A small macOS daemon that gives openSlate's web recorder access to the global cursor position. The browser tab driving `getDisplayMedia` can't see the cursor outside its own DOM; the helper fills that gap with `NSEvent.mouseLocation`, streams positions over a localhost WebSocket, and lets the polish pipeline render a polished cursor sprite at the recorded positions instead of the system arrow.

**No TCC permissions required.** `NSEvent.mouseLocation` is a public Cocoa API; the helper doesn't read keystrokes, doesn't inject events, and doesn't read window contents.

## Build

```bash
# from the repo root
openslate helper build

# or directly
cd helper-mac
swift build -c release
```

Requires Xcode Command-Line Tools (`xcode-select --install`). Resulting binary at `helper-mac/.build/release/openslate-helper`.

## Run

```bash
openslate helper start
# → openslate-helper: listening on 127.0.0.1:9292
```

Leave it running in a terminal while you use `openslate record-web` in another. The browser auto-detects the helper at `ws://127.0.0.1:9292`; if absent, the web recorder falls back to capturing the system cursor in the video.

## Wire protocol

JSON over WebSocket, line-delimited text frames.

```jsonc
// client → server
{"cmd": "start"}      // begin streaming
{"cmd": "stop"}       // end streaming

// server → client
{"type": "started", "screen_w": 3840, "screen_h": 2160, "scale": 2}
{"type": "cursor", "t_ms": 17, "x": 824, "y": 412}    // ~125 Hz while running
```

Coordinates are absolute screen pixels at the helper's reported scale. The web app translates them into capture-relative coords using the captured video's resolution from the manifest.

## Why a separate binary

Three reasons:
- The browser sandbox can't expose global cursor state — that's a security boundary by design.
- We want zero TCC prompts in the common case. Reading `NSEvent.mouseLocation` from a small CLI is as far from screen-recording-as-a-malware-vector as you can get; macOS doesn't ask for permission for it.
- The helper never sees pixel content; it stays out of the screen-capture trust path entirely. The browser does the actual recording.

The trade for this is a one-time `swift build` step on first run. Acceptable for the audience this is targeting.

## Single-client design

The helper drops any prior connection on a new one. Don't run two openSlate web recorders against the same helper at once.

## Stopping

`Ctrl+C` in the terminal running `openslate helper start`. The helper traps `SIGINT` and exits cleanly.
