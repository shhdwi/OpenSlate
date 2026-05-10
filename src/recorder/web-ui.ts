/**
 * The recorder UI page served by web-server.ts. A single self-contained
 * HTML document — no build step, no framework, no external network
 * deps. Style is intentionally calm; this is the openSlate brand.
 *
 * Lifecycle:
 *   1. User clicks "Start"
 *   2. navigator.mediaDevices.getDisplayMedia → user picks a screen/window/tab
 *   3. We MediaRecorder the stream into chunks
 *   4. User clicks "Stop"
 *   5. We POST the assembled blob to /upload as multipart/form-data
 *   6. Server processes; we poll /status and show the final mp4 path
 */

export const RECORDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>openSlate · Web recorder</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    margin: 0;
    padding: 48px 32px;
    background: linear-gradient(180deg, #0a0a0f 0%, #1a1a2f 100%);
    color: #f7f7fa;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  main {
    max-width: 560px;
    width: 100%;
    text-align: center;
  }
  h1 {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
  }
  .sub {
    color: #9c9caa;
    font-size: 14px;
    margin: 0 0 40px;
  }
  button {
    font-family: inherit;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: 0;
    border: 0;
    border-radius: 12px;
    padding: 14px 28px;
    cursor: pointer;
    transition: transform 100ms ease-out, opacity 150ms ease-out;
  }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
  .primary {
    background: #5b5bff;
    color: #fff;
  }
  .primary:hover:not(:disabled) { background: #4848e0; }
  .danger {
    background: #ff4848;
    color: #fff;
  }
  .danger:hover:not(:disabled) { background: #e03c3c; }
  .status {
    margin-top: 32px;
    padding: 16px 20px;
    border-radius: 10px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    font-size: 13px;
    color: #cccdd5;
    text-align: left;
    line-height: 1.6;
  }
  .status code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(255,255,255,0.05);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
    color: #ffc857;
    word-break: break-all;
  }
  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 36px;
    font-weight: 600;
    margin: 8px 0 24px;
    color: #ffc857;
    visibility: hidden;
  }
  .timer.live { visibility: visible; }
  .row { display: flex; justify-content: center; gap: 12px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>openSlate</h1>
  <p class="sub">Record any window or screen. Polish locally. Export an mp4.</p>

  <div class="timer" id="timer">00:00</div>

  <div class="row">
    <button id="start" class="primary">Start recording</button>
    <button id="stop" class="danger hidden" disabled>Stop</button>
  </div>

  <div class="status" id="status">
    Click <strong>Start recording</strong>, choose a window or screen, perform your demo, then click <strong>Stop</strong>. The polish runs locally; no upload to any remote server.
  </div>
</main>

<script>
(() => {
  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");
  const status = document.getElementById("status");
  const timer = document.getElementById("timer");

  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerHandle = null;

  function setStatus(html) { status.innerHTML = html; }
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return mm + ":" + ss;
  }

  let helperWs = null;
  let helperConnected = false;
  let helperStarted = null; // { screen_w, screen_h, scale }
  let cursorSamples = []; // collected during recording

  // Try to connect to openslate-helper. If it's running we get clean
  // cursor data + can hide the system cursor in the capture; if not,
  // fall back to a system-cursor-visible recording.
  async function connectHelper(timeoutMs) {
    return new Promise((resolve) => {
      let resolved = false;
      const ws = new WebSocket("ws://127.0.0.1:9292");
      const finish = (ok) => {
        if (resolved) return;
        resolved = true;
        resolve(ok);
      };
      ws.onopen = () => {
        helperWs = ws;
        helperConnected = true;
        finish(true);
      };
      ws.onerror = () => finish(false);
      setTimeout(() => finish(false), timeoutMs);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "started") {
            helperStarted = { screen_w: m.screen_w, screen_h: m.screen_h, scale: m.scale };
          } else if (m.type === "cursor") {
            cursorSamples.push({ t_ms: m.t_ms, x: m.x, y: m.y });
          }
        } catch {}
      };
    });
  }

  startBtn.addEventListener("click", async () => {
    cursorSamples = [];
    helperStarted = null;

    // Try the helper first; 250 ms is plenty for a localhost WS open.
    const ok = await connectHelper(250);
    const useNativeCursor = ok;

    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          // With the helper, hide the system cursor — we'll redraw
          // our own polished sprite at the recorded positions.
          // Without it, leave the system cursor visible (no source for
          // position data, so an "empty" recording would have nothing).
          cursor: useNativeCursor ? "never" : "always",
        },
        audio: false,
      });
    } catch (err) {
      setStatus("Permission denied or no display selected. Try again.");
      return;
    }

    if (helperWs && helperConnected) {
      helperWs.send(JSON.stringify({ cmd: "start" }));
    }

    // Stop chosen by closing the share-banner: end the recording cleanly.
    mediaStream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    });

    // Pick the best available webm codec. Newer Chromes support av01;
    // most still ship with vp9. h264 (Safari) handled via fallback.
    const candidates = [
      "video/webm;codecs=av01",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/mp4;codecs=h264",
    ];
    const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
    chunks = [];
    recorder = new MediaRecorder(mediaStream, { mimeType, videoBitsPerSecond: 8_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = onRecordingStop;
    recorder.start(1000); // 1s chunks; final blob assembled on stop

    startedAt = Date.now();
    timer.classList.add("live");
    timerHandle = setInterval(() => {
      timer.textContent = fmtTime(Date.now() - startedAt);
    }, 200);
    startBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    stopBtn.disabled = false;
    setStatus("Recording. Click <strong>Stop</strong> when you're done.");
  });

  stopBtn.addEventListener("click", () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    if (helperWs && helperConnected) {
      helperWs.send(JSON.stringify({ cmd: "stop" }));
      helperWs.close();
      helperWs = null;
      helperConnected = false;
    }
  });

  async function onRecordingStop() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    timer.classList.remove("live");
    stopBtn.disabled = true;

    const blob = new Blob(chunks, { type: chunks[0]?.type || "video/webm" });
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const sizeMb = (blob.size / 1024 / 1024).toFixed(2);

    setStatus(\`Uploading \${sizeMb} MB to local server…\`);

    const fd = new FormData();
    fd.append("video", blob, "recording." + ext);
    fd.append("duration_ms", String(Date.now() - startedAt));
    // Cursor data — empty array if no helper. Server treats absence as
    // "no native cursor stream"; the polish pipeline falls back to
    // not rendering a cursor sprite (the captured video already shows
    // the system cursor in that mode).
    fd.append("cursor_samples", JSON.stringify(cursorSamples));
    if (helperStarted) {
      fd.append("helper_screen", JSON.stringify(helperStarted));
    }
    let res;
    try {
      res = await fetch("/upload", { method: "POST", body: fd });
    } catch (err) {
      setStatus("Upload failed: " + (err && err.message ? err.message : err));
      return;
    }
    if (!res.ok) {
      setStatus("Upload failed: " + res.status + " " + res.statusText);
      return;
    }
    const j = await res.json();
    if (j.error) { setStatus("Server error: " + j.error); return; }
    setStatus(\`Polishing… recording id <code>\${j.recording_id}\`);

    // Poll for completion. Cap at ~6 minutes (450 polls × 800ms) so
    // an unresponsive server doesn't loop forever in the user's tab.
    let polls = 0;
    const POLL_CEILING = 450;
    const poll = async () => {
      if (polls++ > POLL_CEILING) {
        setStatus("Polish timed out. Check the server logs.");
        return;
      }
      const r = await fetch("/status?id=" + encodeURIComponent(j.recording_id));
      const s = await r.json();
      if (s.state === "done") {
        setStatus(
          "Done! Output: <code>" + s.output_path + "</code><br>" +
          (s.size_bytes ? (s.size_bytes / 1024 / 1024).toFixed(2) + " MB · " : "") +
          "Auto-opened on macOS. You can close this tab."
        );
        return;
      }
      if (s.state === "error") {
        setStatus("Polish failed: <code>" + (s.error || "unknown") + "</code>");
        return;
      }
      setStatus("Polishing… <code>" + s.state + "</code>");
      setTimeout(poll, 800);
    };
    poll();
  }
})();
</script>
</body>
</html>`;
