/**
 * Frame-source abstraction for the PixiJS live preview.
 *
 * Why an abstraction: the same PreviewEngine runs in three contexts
 * (Electron renderer for the Mac app, browser tab for the webapp,
 * future test harnesses) each of which serves bundle files differently.
 * The engine asks for "the texture for output time T" and the embedding
 * surface plugs in the right resolver.
 *
 * Two impls land today:
 *  - PngSequenceFrameSource: resolves URLs via a caller-provided prefix
 *    (the Mac app registers an osl-frame:// protocol; the webapp can use
 *    blob URLs from a service-worker cache). Picks the right PNG via
 *    `pickFrameAtSrcTime` so we never show a future frame.
 *  - NullFrameSource: a no-op for bundles with no frames on disk (e.g.
 *    the synthetic fixture). PreviewEngine falls back to its placeholder.
 *
 * Future: Mp4FrameSource (HTMLVideoElement + currentTime seek) for
 * bundles that ship raw/capture.mp4 instead of a PNG sequence.
 */

import { Assets, Texture } from "pixi.js";
import { pickFrameAtSrcTime, frameFileName } from "../compositor/frame-source-math.js";
import type { EditPlan } from "../plan/edit-plan.js";
import type { RecordingManifest } from "../recorder/events.js";
import { outToSrc } from "../compositor/camera.js";

/**
 * Resolves the right Texture for a given output time. Implementations
 * are responsible for their own caching and prefetch strategy.
 */
export interface FrameSource {
  /**
   * Get the texture to display at this output time. Returns null when
   * no source frames are available; the engine falls back to a
   * placeholder so the camera math is still visible.
   */
  getTextureForOutputTime(out_t_ms: number): Promise<Texture | null>;
  /** Optional warmup hook — let the source prefetch the first frame. */
  prime?(): Promise<void>;
  /** Tear down any retained URLs / caches. */
  destroy(): void;
}

/** No-op source for bundles that ship no frames (the fixture, etc.). */
export class NullFrameSource implements FrameSource {
  async getTextureForOutputTime(): Promise<Texture | null> {
    return null;
  }
  destroy(): void {
    /* no-op */
  }
}

export interface PngSequenceFrameSourceOptions {
  /** URL prefix that, when joined with `frames/frame_NNNNNN.png`, returns
   *  the PNG bytes. e.g. "osl-frame://<bundle-id>/" in the Mac app. */
  urlPrefix: string;
  manifest: RecordingManifest;
  editPlan: EditPlan;
  /** Cache size (frames). Defaults to 32. Tunable for memory-vs-scrub
   *  smoothness tradeoffs in long recordings. */
  cacheSize?: number;
}

/**
 * PNG-sequence frame source. Loads frames lazily via `Assets.load(url)`
 * and keeps a small in-memory LRU. PixiJS internally caches Textures by
 * URL too, so our LRU is mostly about bounding GPU memory in long
 * scrubs — Pixi's cache is unbounded.
 */
export class PngSequenceFrameSource implements FrameSource {
  private opts: Required<PngSequenceFrameSourceOptions>;
  private lru = new Map<number, Texture>();
  private inflight = new Map<number, Promise<Texture>>();
  /** Tracks the last frame_index handed out so we can keep it warm in
   *  the LRU even if many other frames evict it on a long scrub. */
  private lastDelivered: number | null = null;

  constructor(opts: PngSequenceFrameSourceOptions) {
    this.opts = {
      urlPrefix: opts.urlPrefix.endsWith("/") ? opts.urlPrefix : `${opts.urlPrefix}/`,
      manifest: opts.manifest,
      editPlan: opts.editPlan,
      cacheSize: opts.cacheSize ?? 32,
    };
  }

  async prime(): Promise<void> {
    // Touch frame 0 so the first paint after load is instant.
    if (this.opts.manifest.frame_indices.length === 0) return;
    const first = this.opts.manifest.frame_indices[0]!;
    await this.loadFrame(first);
  }

  async getTextureForOutputTime(out_t_ms: number): Promise<Texture | null> {
    const { editPlan, manifest } = this.opts;
    const src_t = outToSrc(out_t_ms, editPlan.segments, editPlan.playback_rate);
    if (src_t == null) return null;
    const picked = pickFrameAtSrcTime(manifest, src_t);
    if (!picked) return null;
    return this.loadFrame(picked.frame_index);
  }

  private async loadFrame(frame_index: number): Promise<Texture> {
    const cached = this.lru.get(frame_index);
    if (cached) {
      // Refresh recency.
      this.lru.delete(frame_index);
      this.lru.set(frame_index, cached);
      this.lastDelivered = frame_index;
      return cached;
    }
    const existing = this.inflight.get(frame_index);
    if (existing) return existing;

    const url = `${this.opts.urlPrefix}frames/${frameFileName(frame_index)}`;
    const promise = (Assets.load(url) as Promise<Texture>).then((tex) => {
      this.inflight.delete(frame_index);
      this.put(frame_index, tex);
      return tex;
    });
    this.inflight.set(frame_index, promise);
    return promise;
  }

  private put(frame_index: number, tex: Texture): void {
    this.lru.set(frame_index, tex);
    this.lastDelivered = frame_index;
    while (this.lru.size > this.opts.cacheSize) {
      // Evict the oldest entry that isn't the most-recently-delivered.
      const oldestKey = this.lru.keys().next().value;
      if (oldestKey === undefined) break;
      if (oldestKey === this.lastDelivered && this.lru.size > 1) {
        // Skip — find the next-oldest instead.
        const iter = this.lru.keys();
        iter.next();
        const second = iter.next().value;
        if (second !== undefined) this.lru.delete(second);
        else break;
      } else {
        this.lru.delete(oldestKey);
      }
    }
  }

  destroy(): void {
    this.lru.clear();
    this.inflight.clear();
  }
}
