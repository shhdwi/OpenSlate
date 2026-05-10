/**
 * Recorder page served by web-server.ts. Single self-contained HTML
 * document — no build step, no framework, no external network deps.
 *
 * Lifecycle:
 *   1. Page load → probe openslate-helper on ws://127.0.0.1:9292
 *   2. User clicks "Start" → getDisplayMedia (cursor stripped if helper
 *      present); MediaRecorder begins; helper streams cursor + click
 *      events
 *   3. User clicks "Stop" → POST blob + helper events to /upload
 *   4. Server polishes; we poll /status and show the final mp4 path
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
    margin: 0 0 28px;
  }
  button {
    font-family: inherit;
    font-size: 15px;
    font-weight: 500;
    border: 0;
    border-radius: 12px;
    padding: 14px 28px;
    cursor: pointer;
    transition: transform 100ms ease-out, opacity 150ms ease-out;
  }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
  .primary { background: #5b5bff; color: #fff; }
  .primary:hover:not(:disabled) { background: #4848e0; }
  .danger { background: #ff4848; color: #fff; }
  .danger:hover:not(:disabled) { background: #e03c3c; }
  .row { display: flex; justify-content: center; gap: 12px; }
  .hidden { display: none !important; }

  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 36px;
    font-weight: 600;
    margin: 8px 0 24px;
    color: #ffc857;
    visibility: hidden;
  }
  .timer.live { visibility: visible; }

  /* Capability panel — shows helper / accessibility state */
  .caps {
    margin: 0 0 24px;
    padding: 14px 18px;
    border-radius: 10px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    text-align: left;
    font-size: 13px;
    line-height: 1.5;
  }
  .caps .item {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #9c9caa;
  }
  .caps .item + .item { margin-top: 6px; }
  .caps .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .caps .ok .dot { background: #4dd987; box-shadow: 0 0 6px #4dd987; }
  .caps .ok { color: #f7f7fa; }
  .caps .miss .dot { background: #585866; }
  .caps a { color: #ffc857; }

  .status {
    margin-top: 24px;
    padding: 14px 18px;
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
</style>
</head>
<body>
<main>
  <h1>openSlate</h1>
  <p class="sub">Record any window. Polish locally. Export an mp4.</p>

  <div class="caps" id="caps">
    <div class="item miss" id="cap-helper">
      <div class="dot"></div>
      <div><strong>Helper</strong> — checking…</div>
    </div>
    <div class="item miss" id="cap-ax">
      <div class="dot"></div>
      <div><strong>Accessibility</strong> — checked when recording starts</div>
    </div>
  </div>

  <div class="timer" id="timer">00:00</div>

  <div class="row">
    <button id="start" class="primary">Start recording</button>
    <button id="stop" class="danger hidden" disabled>Stop</button>
  </div>

  <div class="status" id="status">
    Click <strong>Start recording</strong>, choose a window or screen, perform your demo, then click <strong>Stop</strong>. Polish runs locally; nothing leaves your machine.
  </div>
</main>

<script>
(() => {
  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");
  const status = document.getElementById("status");
  const timer = document.getElementById("timer");
  const capHelper = document.getElementById("cap-helper");
  const capAx = document.getElementById("cap-ax");

  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerHandle = null;

  let helperWs = null;
  let helperConnected = false;
  let helperStarted = null;
  let helperHasAccessibility = false;
  let cursorSamples = [];
  let clickEvents = [];

  function setStatus(html) { status.innerHTML = html; }
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return mm + ":" + ss;
  }
  function setCap(el, ok, html) {
    el.classList.remove("ok", "miss");
    el.classList.add(ok ? "ok" : "miss");
    el.querySelector("div:last-child").innerHTML = html;
  }

  // Try to open a WebSocket to the helper. Used both at page load
  // (status probe) and at record start (live data). Resolves with the
  // WebSocket on success, null on failure or timeout.
  function openHelperWs(timeoutMs) {
    return new Promise((resolve) => {
      let resolved = false;
      const ws = new WebSocket("ws://127.0.0.1:9292");
      const finish = (val) => { if (!resolved) { resolved = true; resolve(val); } };
      ws.onopen = () => finish(ws);
      ws.onerror = () => finish(null);
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  // Probe at page load. Open a WS, send {cmd:"start"} just long enough
  // to hear the {type:"started", accessibility:bool} message, then
  // close. This tells us whether to show the AX permission line.
  async function probeHelper() {
    setCap(capHelper, false, "<strong>Helper</strong> — checking…");
    const ws = await openHelperWs(300);
    if (!ws) {
      setCap(capHelper, false,
        "<strong>Helper not running</strong> — recordings will use the system cursor. " +
        "<a href=\\"https://github.com/shhdwi/openslate/tree/main/helper-mac\\" target=\\"_blank\\" rel=\\"noopener\\">Install</a>.");
      setCap(capAx, false, "<strong>Accessibility</strong> — n/a without helper");
      return;
    }
    setCap(capHelper, true, "<strong>Helper detected</strong>");
    let gotStarted = false;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "started" && !gotStarted) {
          gotStarted = true;
          if (m.accessibility) {
            setCap(capAx, true,
              "<strong>Accessibility granted</strong> — full click polish");
          } else {
            setCap(capAx, false,
              "<strong>Accessibility not granted</strong> — clicks detected by heuristic. " +
              "Grant in System Settings → Privacy & Security → Accessibility for precise click events.");
          }
          ws.send(JSON.stringify({ cmd: "stop" }));
          ws.close();
        }
      } catch {}
    };
    ws.send(JSON.stringify({ cmd: "start" }));
  }

  probeHelper();

  // Open a fresh WS for the actual recording. Live stream of cursor
  // and click events into our local arrays.
  async function connectHelperForRecording() {
    const ws = await openHelperWs(250);
    if (!ws) return false;
    helperWs = ws;
    helperConnected = true;
    cursorSamples = [];
    clickEvents = [];
    helperHasAccessibility = false;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "started") {
          helperStarted = { screen_w: m.screen_w, screen_h: m.screen_h, scale: m.scale };
          helperHasAccessibility = !!m.accessibility;
        } else if (m.type === "cursor") {
          cursorSamples.push({ t_ms: m.t_ms, x: m.x, y: m.y, kind: m.kind || "arrow" });
        } else if (m.type === "click") {
          clickEvents.push({ t_ms: m.t_ms, x: m.x, y: m.y, kind: m.kind || "left" });
        }
      } catch {}
    };
    ws.onclose = () => { helperConnected = false; };
    ws.send(JSON.stringify({ cmd: "start" }));
    return true;
  }

  startBtn.addEventListener("click", async () => {
    helperStarted = null;
    const useHelper = await connectHelperForRecording();

    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          // With the helper, hide the system cursor — we'll redraw
          // our own polished sprite at the recorded positions.
          // Without it, leave the system cursor visible (no source for
          // position data, so an "empty" recording would have nothing).
          cursor: useHelper ? "never" : "always",
        },
        audio: false,
      });
    } catch (err) {
      setStatus("Permission denied or no display selected. Try again.");
      if (helperWs) { helperWs.close(); helperWs = null; helperConnected = false; }
      return;
    }

    mediaStream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    });

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
    recorder.start(1000);

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
    fd.append("cursor_samples", JSON.stringify(cursorSamples));
    fd.append("click_events", JSON.stringify(clickEvents));
    if (helperStarted) fd.append("helper_screen", JSON.stringify(helperStarted));

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
        // Reset UI for another take.
        startBtn.classList.remove("hidden");
        stopBtn.classList.add("hidden");
        setStatus(
          "Done! Output: <code>" + s.output_path + "</code><br>" +
          (s.size_bytes ? (s.size_bytes / 1024 / 1024).toFixed(2) + " MB · " : "") +
          "Auto-opened on macOS. Press <strong>Start</strong> for another take."
        );
        return;
      }
      if (s.state === "error") {
        startBtn.classList.remove("hidden");
        stopBtn.classList.add("hidden");
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
