/**
 * Local HTTP server for the web recorder. Serves the recording UI on
 * GET /, accepts the captured blob on POST /upload, and reports
 * processing status on GET /status?id=<recording_id>.
 *
 * Three deliberate constraints:
 *   - Binds to 127.0.0.1 only (never reachable from the network).
 *   - No auth: trust the loopback. The server lives only as long as
 *     the openslate CLI process.
 *   - Zero deps beyond Node stdlib. http + child_process + fs are
 *     enough for what's needed; pulling in express/koa/hono would be
 *     a full order of magnitude more code than the server itself.
 *
 * The server runs the polish pipeline in the BACKGROUND on upload —
 * the upload response returns immediately with a recording_id, and
 * the browser polls /status. This keeps the upload from timing out
 * during the ~30–90s render.
 */

import { spawn } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { ingestVideo } from "./video-ingest.js";
import {
  orchestrateExport,
  orchestratePlanEdit,
} from "../core/orchestrate.js";
import { ensureProjectDirs, recordingDir } from "../utils/paths.js";
import { RECORDER_HTML } from "./web-ui.js";

type JobState =
  | "uploaded"
  | "ingesting"
  | "planning"
  | "rendering"
  | "done"
  | "error";

interface Job {
  id: string;
  state: JobState;
  output_path?: string;
  size_bytes?: number;
  error?: string;
}

export interface WebRecorderOptions {
  rootDir?: string;
  /** Preferred port; falls back to a random free port if taken. */
  port?: number;
  /**
   * Called once per completed recording. The server keeps running so
   * the user can record multiple takes from the same browser tab; the
   * CLI uses this to print each result to stdout.
   */
  onJobDone?: (result: { recording_id: string; output_path: string; size_bytes: number }) => void;
  /** Called when a job errors. */
  onJobError?: (result: { recording_id: string; error: string }) => void;
}

export interface WebRecorderHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the local recorder server. Returns a handle exposing the URL
 * to open in the browser plus a `done` promise that fires after the
 * first successful recording.
 */
export async function startWebRecorderServer(
  opts: WebRecorderOptions = {},
): Promise<WebRecorderHandle> {
  const rootDir = opts.rootDir ?? process.cwd();
  const paths = await ensureProjectDirs(rootDir);
  const jobs = new Map<string, Job>();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        return sendHtml(res, RECORDER_HTML);
      }
      if (req.method === "POST" && req.url === "/upload") {
        return await handleUpload(req, res);
      }
      if (req.method === "GET" && req.url?.startsWith("/status")) {
        return handleStatus(req, res);
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;

  return {
    url,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  // ── handlers ────────────────────────────────────────────────────────
  async function handleUpload(req: IncomingMessage, res: ServerResponse) {
    const recording_id = `web-${Date.now()}`;
    const dir = recordingDir(paths, recording_id);
    await fs.mkdir(dir, { recursive: true });
    const video_path = path.join(dir, "source.webm");
    let parsed: ParsedUpload;
    try {
      parsed = await parseMultipart(req, video_path);
    } catch (err) {
      sendJson(res, 400, { error: `multipart parse: ${(err as Error).message}` });
      return;
    }

    const job: Job = { id: recording_id, state: "uploaded" };
    jobs.set(recording_id, job);

    // Respond immediately; do polish in background.
    sendJson(res, 200, { recording_id });

    // Fire and forget; status endpoint surfaces progress + result.
    void runPolishJob(job, dir, video_path, parsed);
  }

  async function runPolishJob(
    job: Job,
    dir: string,
    video_path: string,
    parsed: ParsedUpload,
  ): Promise<void> {
    try {
      job.state = "ingesting";
      await ingestVideo({
        video_path,
        recording_dir: dir,
        recording_id: job.id,
        fps: 60,
      });

      // If the helper streamed cursor data, replace ingestVideo's
      // empty cursor.json + frame_start-only events.json with the
      // real position track + heuristic click events. Coordinates
      // come in as absolute screen pixels at the helper's reported
      // scale; we down-rescale to the captured video's native
      // resolution (which is what manifest.viewport stores).
      if (parsed.cursor_samples.length > 0 && parsed.helper_screen) {
        await writeCursorAndClicks(
          dir,
          parsed.cursor_samples,
          parsed.helper_screen,
        );
      }

      job.state = "planning";
      await orchestratePlanEdit({ recording_id: job.id, rootDir });

      job.state = "rendering";
      const out = await orchestrateExport({ recording_id: job.id, rootDir });
      job.output_path = out.output_path;
      job.size_bytes = out.size_bytes;
      job.state = "done";

      if (process.platform === "darwin") {
        spawn("open", [out.output_path], { detached: true, stdio: "ignore" }).unref();
      }
      opts.onJobDone?.({
        recording_id: job.id,
        output_path: out.output_path,
        size_bytes: out.size_bytes,
      });
    } catch (err) {
      job.state = "error";
      job.error = (err as Error).message;
      opts.onJobError?.({ recording_id: job.id, error: job.error });
    }
  }

  function handleStatus(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", "http://x");
    const id = u.searchParams.get("id");
    if (!id) return sendJson(res, 400, { error: "id required" });
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: "unknown id" });
    sendJson(res, 200, job);
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, body: string) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

interface ParsedUpload {
  cursor_samples: Array<{ t_ms: number; x: number; y: number }>;
  helper_screen: { screen_w: number; screen_h: number; scale: number } | null;
}

/**
 * Write the helper-derived cursor track to cursor.json and detect
 * heuristic click events from cursor motion (settle → tiny jitter →
 * resume), writing them to events.json. Coordinates are translated
 * from helper screen-pixels into the captured video's viewport coords
 * by reading manifest.json (written by ingestVideo just before this).
 *
 * Click heuristic — cheap and good-enough for v1:
 *   - "settled" = cursor stays within 2px for >= 120ms
 *   - end of a settled window where the cursor then moves > 8px is a
 *     candidate click
 *   - dedupe to one event per ~500ms cluster
 */
async function writeCursorAndClicks(
  recording_dir: string,
  raw_samples: Array<{ t_ms: number; x: number; y: number }>,
  helper_screen: { screen_w: number; screen_h: number; scale: number },
): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(recording_dir, "manifest.json"), "utf8"),
  );
  const vp_w: number = manifest.viewport.width;
  const vp_h: number = manifest.viewport.height;
  // The helper reports in screen pixels at the helper's scale. The
  // captured video frames are at vp_w × vp_h pixels (whatever
  // getDisplayMedia returned). Linear scale.
  const sx = vp_w / Math.max(1, helper_screen.screen_w);
  const sy = vp_h / Math.max(1, helper_screen.screen_h);

  const cursor_json = raw_samples.map((s) => ({
    t_ms: s.t_ms,
    x: Math.round(s.x * sx),
    y: Math.round(s.y * sy),
  }));
  await fs.writeFile(
    path.join(recording_dir, "cursor.json"),
    JSON.stringify(cursor_json),
  );

  const clicks = detectClicks(cursor_json);
  // Replace events.json (ingestVideo wrote a frame_start-only stub).
  await fs.writeFile(
    path.join(recording_dir, "events.json"),
    JSON.stringify(
      [
        { kind: "frame_start", t_ms: 0 },
        ...clicks.map((c, i) => ({
          kind: "click" as const,
          t_ms: c.t_ms,
          x: c.x,
          y: c.y,
          step_index: i,
          synthetic: true,
        })),
      ],
      null,
      2,
    ),
  );
}

/**
 * Detect probable click moments from a cursor track. Returns one event
 * per detected click. Tunable thresholds; calibrated against real
 * recordings in v1.5 if needed.
 */
function detectClicks(
  samples: Array<{ t_ms: number; x: number; y: number }>,
): Array<{ t_ms: number; x: number; y: number }> {
  if (samples.length < 4) return [];
  const SETTLE_RADIUS_PX = 2;
  const SETTLE_MIN_MS = 120;
  const RESUME_DELTA_PX = 8;
  const DEDUPE_MS = 500;

  const out: Array<{ t_ms: number; x: number; y: number }> = [];
  let settledStart = 0;
  let settledX = samples[0]!.x;
  let settledY = samples[0]!.y;
  let settled = true;

  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    const d = Math.hypot(s.x - settledX, s.y - settledY);
    if (settled) {
      if (d <= SETTLE_RADIUS_PX) continue;
      // We left the settled window. Was it long enough to count as a
      // click candidate?
      const dwellMs = s.t_ms - samples[settledStart]!.t_ms;
      if (dwellMs >= SETTLE_MIN_MS && d >= RESUME_DELTA_PX) {
        const last = out[out.length - 1];
        if (!last || s.t_ms - last.t_ms >= DEDUPE_MS) {
          out.push({ t_ms: samples[settledStart]!.t_ms + Math.round(dwellMs / 2), x: settledX, y: settledY });
        }
      }
      settled = false;
      continue;
    }
    // Not settled — start a new candidate dwell window.
    settledStart = i;
    settledX = s.x;
    settledY = s.y;
    settled = true;
  }
  return out;
}

/**
 * Stream a multipart/form-data POST: pipe the `video` part to disk,
 * collect any text-valued parts (`cursor_samples`, `helper_screen`)
 * into memory.
 *
 * State machine:
 *   - HEADER: accumulate until we see a part's `\r\n\r\n`. Bounded by
 *     the size of part-headers (~200 bytes).
 *   - CONTENT-VIDEO: stream chunks to disk minus a `boundary.length+4`
 *     carry buffer to detect a boundary that straddles chunks. No
 *     unbounded Buffer.concat.
 *   - CONTENT-TEXT: accumulate the whole part in memory (text fields
 *     are small) and capture on completion.
 *
 * The only client is our own browser page; we know the field names
 * and part order. A full parser (busboy/formidable) would be 500 lines
 * of dependency for what's needed.
 */
async function parseMultipart(
  req: IncomingMessage,
  video_path: string,
): Promise<ParsedUpload> {
  const ct = req.headers["content-type"] ?? "";
  const m = ct.match(/boundary=([^;]+)/);
  if (!m) throw new Error("missing boundary");
  const boundary = Buffer.from(`--${m[1]}`);
  const headerEnd = Buffer.from("\r\n\r\n");
  // Bytes held back at the tail in CONTENT state so a boundary that
  // straddles two chunks is still detectable.
  const tailReserve = boundary.length + 4;

  type Mode = "seek_part" | "video" | "text" | "done";
  let mode: Mode = "seek_part";
  let buf = Buffer.alloc(0); // accumulator in seek_part + text modes
  let carry = Buffer.alloc(0); // bounded carry in video mode
  let videoSink: ReturnType<typeof createWriteStream> | null = null;
  let textField: string | null = null; // current text part name
  let textBuf = "";

  const result: ParsedUpload = { cursor_samples: [], helper_screen: null };

  return new Promise((resolve, reject) => {
    req.on("data", onChunk);
    req.on("end", onEnd);
    req.on("error", reject);

    function onChunk(chunk: Buffer) {
      if (mode === "done") return;
      if (mode === "video") {
        consumeVideo(chunk);
        return;
      }
      // seek_part or text — accumulate then drive the part loop
      buf = Buffer.concat([buf, chunk]);
      tickParts();
    }

    function tickParts() {
      // Drain as many parts as possible from `buf`. Returns when we
      // need more data.
      while (true) {
        if (mode === "seek_part") {
          const bIdx = buf.indexOf(boundary);
          if (bIdx < 0) return; // need more data
          const headersStart = bIdx + boundary.length;
          const headersEnd = buf.indexOf(headerEnd, headersStart);
          if (headersEnd < 0) return;
          const headers = buf.slice(headersStart, headersEnd).toString();
          const contentStart = headersEnd + headerEnd.length;
          const nameMatch = headers.match(/name="([^"]+)"/);
          const name = nameMatch?.[1] ?? "";

          if (name === "video") {
            mode = "video";
            videoSink = createWriteStream(video_path);
            videoSink.on("error", reject);
            const remainder = buf.slice(contentStart);
            buf = Buffer.alloc(0);
            consumeVideo(remainder);
            return;
          }
          if (name === "cursor_samples" || name === "helper_screen") {
            mode = "text";
            textField = name;
            textBuf = "";
            buf = buf.slice(contentStart);
            continue;
          }
          // unknown part — skip past its headers and keep scanning
          buf = buf.slice(contentStart);
          continue;
        }
        if (mode === "text") {
          // Accumulate text content until the next boundary marker.
          // Text parts are small — no chunk-streaming optimization.
          const bIdx = buf.indexOf(boundary);
          if (bIdx < 0) {
            // Hold back enough bytes that a boundary spanning a future
            // chunk is still detectable on the next pass.
            const safeUpTo = Math.max(0, buf.length - tailReserve);
            textBuf += buf.slice(0, safeUpTo).toString();
            buf = buf.slice(safeUpTo);
            return;
          }
          // Trailing \r\n before boundary is framing.
          textBuf += buf.slice(0, Math.max(0, bIdx - 2)).toString();
          captureTextField();
          buf = buf.slice(bIdx);
          mode = "seek_part";
          continue;
        }
        return;
      }
    }

    function consumeVideo(chunk: Buffer) {
      // Buffer-safe stream-to-disk with a small carry tail to catch
      // boundaries that straddle chunks. After the next boundary we
      // flip back to seek_part for further parts (text fields after
      // the video).
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const bIdx = window.indexOf(boundary);
      if (bIdx >= 0) {
        videoSink?.write(window.slice(0, Math.max(0, bIdx - 2)));
        videoSink?.end();
        videoSink = null;
        carry = Buffer.alloc(0);
        // Anything after `bIdx` belongs to the next part.
        buf = window.slice(bIdx);
        mode = "seek_part";
        tickParts();
        return;
      }
      const flushTo = Math.max(0, window.length - tailReserve);
      if (flushTo > 0) videoSink?.write(window.slice(0, flushTo));
      carry = window.slice(flushTo);
    }

    function captureTextField() {
      if (textField === "cursor_samples") {
        try {
          const arr = JSON.parse(textBuf);
          if (Array.isArray(arr)) {
            result.cursor_samples = arr.filter(
              (s) =>
                s &&
                typeof s.t_ms === "number" &&
                typeof s.x === "number" &&
                typeof s.y === "number",
            );
          }
        } catch {
          // tolerate a bad cursor payload — ingest still produces a
          // working mp4 without it
        }
      } else if (textField === "helper_screen") {
        try {
          const obj = JSON.parse(textBuf);
          if (
            obj &&
            typeof obj.screen_w === "number" &&
            typeof obj.screen_h === "number"
          ) {
            result.helper_screen = {
              screen_w: obj.screen_w,
              screen_h: obj.screen_h,
              scale: typeof obj.scale === "number" ? obj.scale : 1,
            };
          }
        } catch {
          // same — tolerate
        }
      }
      textField = null;
      textBuf = "";
    }

    function onEnd() {
      // Final flush. Any in-flight video carry belongs to the file.
      if (mode === "video" && videoSink) {
        if (carry.length > 0) videoSink.write(carry);
        videoSink.end();
      }
      mode = "done";
      resolve(result);
    }
  });
}
