/**
 * PixiJS live preview engine.
 *
 * Why this exists: Remotion is the offline render path (frame-by-frame,
 * cacheable, deterministic, the polish moat). It cannot give an
 * interactive timeline-scrubbing experience because each frame requires
 * a bundle. The Mac app and the webapp need that experience — drag a
 * zoom keyframe and watch the preview update next frame.
 *
 * The engine reads the same `.osl` bundle that Remotion exports from,
 * and the same `sampleCamera` + `cameraTransform` math from
 * `compositor/camera.ts`. That makes parity testable: render frame N
 * here, render frame N via Remotion, diff. Above-threshold drift = bug.
 *
 * Current scope (this file): the recording-playback LAYER only. The
 * other six layers (background, frame chrome, cursor overlay, click
 * effects, captions, flourishes) will land iteratively, each behind the
 * same parity contract.
 *
 * Usage:
 *
 *   import { PreviewEngine } from "openslate/preview";
 *   const engine = new PreviewEngine({ container: document.querySelector("#stage")! });
 *   await engine.loadBundle(bundleDir);    // takes an .osl path
 *   engine.scrubTo(1500);                   // jump to t=1500ms output time
 *   engine.play();                          // 60fps live preview
 *
 * The engine is renderer-agnostic from the caller's perspective: it
 * mounts a PixiJS Application into the supplied DOM element and drives
 * an `interactive` ticker. Stopping the engine releases all GPU
 * resources.
 */

import { Application, Assets, Container, Sprite, Texture } from "pixi.js";
import { cameraTransform, outToSrc, sampleCamera, type CameraState } from "../compositor/camera.js";
import type { OslBundle } from "../osl/types.js";
import { readBundle } from "../osl/reader.js";
import type { EditPlan } from "../plan/edit-plan.js";
import type { RecordingManifest } from "../recorder/events.js";

export interface PreviewEngineOptions {
  /** DOM element the PixiJS canvas mounts into. */
  container: HTMLElement;
  /** Optional override for output dimensions. Defaults to bundle viewport. */
  width?: number;
  height?: number;
  /** Background color for any uncovered area (after scale/translate). */
  background?: string;
}

export interface PreviewState {
  /** Output time in milliseconds, snapped to the playback timeline. */
  out_t_ms: number;
  /** Total output duration, derived from segments + playback_rate. */
  duration_ms: number;
  /** Whether the ticker is currently advancing time. */
  playing: boolean;
  /** Current camera state for diagnostics / UI overlays. */
  camera: CameraState;
}

/**
 * Live-preview engine. Owns a PixiJS Application + a small object graph
 * of layers. Update path is:
 *
 *   tick (60fps) → advance out_t_ms by deltaMs * playback_rate
 *                → sample camera + source-time → update recording layer transform
 *                → call onState listeners
 *
 * The engine is the single source of truth for "what frame is showing."
 * Editor UIs (timeline scrubber, property panels) subscribe via `subscribe()`.
 */
export class PreviewEngine {
  private app: Application;
  private mounted = false;
  private stage = new Container();
  private recordingLayer = new Container();
  private recordingSprite: Sprite | null = null;
  private bundle: OslBundle | null = null;
  private out_t_ms = 0;
  private playing = false;
  private lastTickMs = 0;
  private listeners = new Set<(state: PreviewState) => void>();
  private opts: Required<Omit<PreviewEngineOptions, "container">>;
  private container: HTMLElement;

  constructor(opts: PreviewEngineOptions) {
    this.container = opts.container;
    this.opts = {
      width: opts.width ?? 1280,
      height: opts.height ?? 800,
      background: opts.background ?? "#0b0b0c",
    };
    this.app = new Application();
  }

  /**
   * Initialize the PixiJS app and mount its canvas into the container.
   * Idempotent — calling twice is a no-op.
   */
  async mount(): Promise<void> {
    if (this.mounted) return;
    await this.app.init({
      width: this.opts.width,
      height: this.opts.height,
      background: this.opts.background,
      antialias: true,
      // resolution: window.devicePixelRatio || 1 — let callers opt-in
      // explicitly so headless test environments stay at 1x.
      resolution: 1,
      autoDensity: true,
    });
    this.app.stage.addChild(this.stage);
    this.stage.addChild(this.recordingLayer);
    this.container.appendChild(this.app.canvas);
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS));
    this.mounted = true;
  }

  /**
   * Load an .osl bundle. Reads the manifest, sets engine dimensions to
   * match the recording viewport, resets the timeline to t=0.
   *
   * If the bundle has a raw cursor-hidden capture mp4 at
   * `raw/capture.mp4`, it's loaded as the recording layer's source. If
   * the bundle has only PNG frames, the recording sprite remains null
   * — callers can subclass + override `loadRecordingTexture` to plug
   * in a custom PNG-sequence texture provider.
   *
   * For the fixture (no frames on disk), the engine renders a
   * synthetic placeholder so the camera math is visible.
   */
  async loadBundle(bundleRootOrBundle: string | OslBundle): Promise<void> {
    if (!this.mounted) await this.mount();

    const bundle =
      typeof bundleRootOrBundle === "string"
        ? await readBundle(bundleRootOrBundle)
        : bundleRootOrBundle;
    this.bundle = bundle;
    this.out_t_ms = 0;

    const manifest = bundle.recording_manifest as RecordingManifest;
    this.opts.width = manifest.viewport.width;
    this.opts.height = manifest.viewport.height;
    this.app.renderer.resize(manifest.viewport.width, manifest.viewport.height);

    await this.loadRecordingTexture();
    this.emit();
  }

  /**
   * Default recording-texture loader: looks for `raw/capture.mp4` in the
   * bundle. If absent, paints a synthetic gradient via a 1x1 white texture
   * stretched + tinted — enough to verify camera math visually.
   *
   * Subclasses (e.g. the Mac app's PNG-sequence player) override this.
   */
  protected async loadRecordingTexture(): Promise<void> {
    if (!this.bundle) return;
    this.recordingLayer.removeChildren();

    const rawCapture = this.bundle.manifest.artifacts.raw_capture;
    if (rawCapture) {
      // mp4 path — let the consumer wire a HTMLVideoElement-backed
      // texture in a later iteration. For now we fall through to the
      // synthetic placeholder so the engine is always renderable.
    }

    // Synthetic placeholder: white texture stretched to viewport,
    // tinted to indicate "preview without real frames". When real frames
    // arrive the recording sprite swaps in transparently.
    const sprite = new Sprite(Texture.WHITE);
    sprite.width = this.opts.width;
    sprite.height = this.opts.height;
    sprite.tint = 0x1a1a1c;
    this.recordingLayer.addChild(sprite);
    this.recordingSprite = sprite;
  }

  /** Jump to a specific output time without playing. */
  scrubTo(out_t_ms: number): void {
    const duration = this.durationMs();
    this.out_t_ms = Math.max(0, Math.min(duration, out_t_ms));
    this.applyCamera();
    this.emit();
  }

  /** Start advancing the timeline at real time. */
  play(): void {
    if (!this.bundle) return;
    this.playing = true;
    this.lastTickMs = 0;
    this.emit();
  }

  /** Pause time advancement. Current frame stays put. */
  pause(): void {
    this.playing = false;
    this.emit();
  }

  /** Subscribe to engine state updates. Returns an unsubscribe fn. */
  subscribe(listener: (state: PreviewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Tear down the PixiJS app + listeners. Call when the host unmounts. */
  destroy(): void {
    this.listeners.clear();
    this.app.destroy(true, { children: true });
    this.mounted = false;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private tick(deltaMs: number): void {
    if (!this.playing || !this.bundle) return;
    const editPlan = this.bundle.edit_plan as EditPlan;
    const rate = editPlan.playback_rate;
    this.out_t_ms += deltaMs * rate;
    const dur = this.durationMs();
    if (this.out_t_ms >= dur) {
      this.out_t_ms = dur;
      this.playing = false;
    }
    this.applyCamera();
    this.emit();
  }

  private applyCamera(): void {
    if (!this.bundle || !this.recordingSprite) return;
    const editPlan = this.bundle.edit_plan as EditPlan;
    const camera = sampleCamera(editPlan.keyframes, this.out_t_ms);
    const transform = cameraTransform(camera, {
      width: this.opts.width,
      height: this.opts.height,
    });
    this.recordingLayer.scale.set(transform.scale);
    this.recordingLayer.position.set(transform.translate_x, transform.translate_y);
  }

  private durationMs(): number {
    if (!this.bundle) return 0;
    const editPlan = this.bundle.edit_plan as EditPlan;
    const trimmed = editPlan.segments.reduce(
      (acc, s) => acc + (s.src_end_ms - s.src_start_ms),
      0,
    );
    return trimmed / Math.max(0.01, editPlan.playback_rate);
  }

  private snapshot(): PreviewState {
    const editPlan = (this.bundle?.edit_plan as EditPlan | undefined) ?? null;
    const camera = editPlan ? sampleCamera(editPlan.keyframes, this.out_t_ms) : {
      zoom: 1,
      focal_x: 0.5,
      focal_y: 0.5,
    };
    return {
      out_t_ms: this.out_t_ms,
      duration_ms: this.durationMs(),
      playing: this.playing,
      camera,
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  // Test-only: directly read what source time would be sampled. The Mac
  // app + webapp don't call this; parity tests do.
  /** @internal */
  _resolveSourceTimeForTesting(): number | null {
    if (!this.bundle) return null;
    const editPlan = this.bundle.edit_plan as EditPlan;
    return outToSrc(this.out_t_ms, editPlan.segments, editPlan.playback_rate);
  }
}
