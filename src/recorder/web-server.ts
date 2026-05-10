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
    try {
      await pipeMultipartVideo(req, video_path);
    } catch (err) {
      sendJson(res, 400, { error: `multipart parse: ${(err as Error).message}` });
      return;
    }

    const job: Job = { id: recording_id, state: "uploaded" };
    jobs.set(recording_id, job);

    // Respond immediately; do polish in background.
    sendJson(res, 200, { recording_id });

    // Fire and forget; status endpoint surfaces progress + result.
    void runPolishJob(job, dir, video_path);
  }

  async function runPolishJob(job: Job, dir: string, video_path: string): Promise<void> {
    try {
      job.state = "ingesting";
      await ingestVideo({
        video_path,
        recording_dir: dir,
        recording_id: job.id,
        fps: 60,
      });

      job.state = "planning";
      await orchestratePlanEdit({ recording_id: job.id, rootDir });

      job.state = "rendering";
      const out = await orchestrateExport({ recording_id: job.id, rootDir });
      job.output_path = out.output_path;
      job.size_bytes = out.size_bytes;
      job.state = "done";

      // Auto-open on macOS for convenience.
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

/**
 * Stream the multipart/form-data POST body to disk, picking only the
 * `video` part. The only client is our own browser page, so we know
 * the part order — a full parser (busboy/formidable) would be 500
 * lines of dependency for one file upload.
 *
 * State machine:
 *   - HEADER: accumulate until we see boundary + part headers + \r\n\r\n.
 *     Bounded by the size of part-headers (~200 bytes).
 *   - CONTENT (only if `name="video"`): every incoming chunk gets
 *     written to disk MINUS the trailing `boundary.length + 4` bytes
 *     held in a small carry-over buffer. This avoids the O(N²)
 *     Buffer.concat that would happen if we accumulated the whole
 *     upload, and guarantees forward progress even on tiny chunks.
 */
async function pipeMultipartVideo(
  req: IncomingMessage,
  out_path: string,
): Promise<void> {
  const ct = req.headers["content-type"] ?? "";
  const m = ct.match(/boundary=([^;]+)/);
  if (!m) throw new Error("missing boundary");
  const boundary = Buffer.from(`--${m[1]}`);
  const headerEnd = Buffer.from("\r\n\r\n");
  // Bytes held back at the tail in CONTENT state so a boundary that
  // straddles two chunks is still detectable.
  const tailReserve = boundary.length + 4;

  const sink = createWriteStream(out_path);
  let mode: "header" | "content" | "done" = "header";
  let headerBuf = Buffer.alloc(0); // bounded — only used in HEADER
  let carry = Buffer.alloc(0); // bounded to tailReserve — only used in CONTENT

  return new Promise((resolve, reject) => {
    const finish = () => {
      mode = "done";
      sink.end(() => resolve());
    };

    req.on("data", (chunk: Buffer) => {
      if (mode === "done") return;

      if (mode === "header") {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const bIdx = headerBuf.indexOf(boundary);
        if (bIdx < 0) return;
        const headersStart = bIdx + boundary.length;
        const headersEnd = headerBuf.indexOf(headerEnd, headersStart);
        if (headersEnd < 0) return;
        const headers = headerBuf.slice(headersStart, headersEnd).toString();
        const contentStart = headersEnd + headerEnd.length;
        if (!/name="video"/.test(headers)) {
          // not the file part — drop and look for the next boundary
          headerBuf = headerBuf.slice(contentStart);
          return;
        }
        // Switch to CONTENT mode; everything after the headers is file bytes.
        const initial = headerBuf.slice(contentStart);
        headerBuf = Buffer.alloc(0);
        mode = "content";
        consumeContent(initial);
        return;
      }

      consumeContent(chunk);
    });

    req.on("end", () => {
      if (mode !== "done") {
        // No closing boundary seen — flush whatever we have.
        if (carry.length > 0) sink.write(carry);
        finish();
      }
    });
    req.on("error", reject);
    sink.on("error", reject);

    function consumeContent(chunk: Buffer) {
      // Treat the (small) leftover from the previous chunk + this chunk
      // as one window. Search for the boundary anywhere in the window;
      // if found, write everything before the trailing CRLF and finish.
      // Otherwise write `window - tailReserve` bytes and keep the rest.
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const bIdx = window.indexOf(boundary);
      if (bIdx >= 0) {
        // Trailing \r\n before the boundary belongs to multipart framing
        // (not file content). bIdx is at least 2 in a well-formed body;
        // Math.max guards a degenerate empty file.
        sink.write(window.slice(0, Math.max(0, bIdx - 2)));
        carry = Buffer.alloc(0);
        finish();
        return;
      }
      const flushTo = Math.max(0, window.length - tailReserve);
      if (flushTo > 0) sink.write(window.slice(0, flushTo));
      carry = window.slice(flushTo);
    }
  });
}
