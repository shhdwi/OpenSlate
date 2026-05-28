/**
 * PixiJS cursor layer for the live preview. Reads cursor.json + the
 * edit-plan, computes the cursor position at the current output time,
 * draws a sprite at that position inside the recording layer (so camera
 * transforms apply to it the same way they apply to the recording).
 *
 * Scope today: raw linear-interp positioning + a default arrow sprite.
 * Spring smoothing, contextual sprite swap, motion blur, sway, click
 * bounce will land in follow-up layers as we port each from the Remotion
 * compositor — each one comes with its own parity test against
 * `compositor/cursor.tsx`.
 */

import { Container, Graphics } from "pixi.js";
import { sampleCursorAtOutTime } from "../../compositor/cursor-math.js";
import type { CursorSample } from "../../recorder/events.js";
import type { EditPlan } from "../../plan/edit-plan.js";

export interface CursorLayerOptions {
  /** Cursor sprite size in viewport pixels. Defaults to 28 (matches Remotion). */
  size?: number;
  /** Sprite tint. The default arrow is light so it reads on dark UIs. */
  tint?: number;
}

/**
 * A self-contained PixiJS Container that renders an arrow-like cursor.
 * Mount it as a child of the recording layer so it scales/translates
 * with the camera. Call `updateAtOutputTime(t_ms)` on every frame.
 */
export class CursorLayer {
  readonly container: Container;
  private sprite: Container;
  private samples: CursorSample[] = [];
  private editPlan: EditPlan | null = null;
  private size: number;

  constructor(opts: CursorLayerOptions = {}) {
    this.size = opts.size ?? 28;
    this.container = new Container();

    // Draw a simple arrow shape via Graphics so we have no asset
    // dependency. The geometry is the macOS-style arrow: tip at (0,0),
    // body extending down-right. Hotspot (the active pixel that lands
    // on the click point) is the tip at (0,0), so we don't pre-translate.
    const sprite = new Container();
    const g = new Graphics();
    const tint = opts.tint ?? 0xffffff;
    const s = this.size;
    g.poly([
      0, 0,
      0, s * 0.78,
      s * 0.21, s * 0.61,
      s * 0.32, s * 0.92,
      s * 0.42, s * 0.88,
      s * 0.31, s * 0.57,
      s * 0.58, s * 0.57,
    ]);
    g.fill({ color: tint });
    g.stroke({ color: 0x000000, width: 1.4, alignment: 1 });
    sprite.addChild(g);
    this.container.addChild(sprite);
    this.sprite = sprite;
  }

  setData(samples: CursorSample[], editPlan: EditPlan): void {
    this.samples = samples;
    this.editPlan = editPlan;
  }

  /** Reposition the sprite for a given output time. */
  updateAtOutputTime(out_t_ms: number): void {
    if (!this.editPlan) return;
    const pos = sampleCursorAtOutTime(
      this.samples,
      out_t_ms,
      this.editPlan.segments,
      this.editPlan.playback_rate,
    );
    if (!pos) {
      this.sprite.visible = false;
      return;
    }
    this.sprite.visible = true;
    this.sprite.position.set(pos.x, pos.y);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
