/**
 * Visual treatment for `highlight` events. Lives INSIDE the Stage so
 * it inherits the camera transform — bbox-positioned overlays track
 * the recording's coordinate space and stay locked to the highlighted
 * element even as the Stage scales / translates.
 *
 * Spotlight model (the default):
 *
 *    The highlighted region renders LIFTED FORWARD off the page —
 *    it's not the camera that zooms; it's the bbox that scales. The
 *    surrounding page is dimmed via the box-shadow trick. A second
 *    copy of the source frame is clip-pathed to the bbox region and
 *    transform-scaled `lift_scale` (default 1.15×) from the bbox
 *    center, giving the illusion of a card popping toward the
 *    viewer. Drop shadow underneath completes the depth cue.
 *
 *    This is fundamentally different from a camera zoom (which moves
 *    the whole scene). Here only the bbox content is enlarged;
 *    surrounding content stays at base scale + dimmed.
 *
 * border_glow model:
 *    Pulsing brand-accent border + outer glow around the bbox. No
 *    lift; no dim. For tutorial / instructional flows.
 *
 * off:
 *    No treatment; camera move alone signals attention.
 *
 * Timing: visible during the highlight envelope (in + hold + out).
 * Opacity follows the same ease curves as the camera's zoom envelope
 * so the treatment doesn't pop in/out.
 */

import React from "react";
import { Img } from "remotion";
import type {
  BrandKit,
  FlourishHighlightTreatment,
  ZoomProfile,
} from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";

export interface HighlightTreatmentProps {
  events: RecordedEvent[];
  t_ms: number;
  viewport_width: number;
  viewport_height: number;
  zoom: ZoomProfile;
  brand: BrandKit;
  config: FlourishHighlightTreatment;
  /**
   * URL of the current source frame. Used by the spotlight style to
   * render a clipped + scaled copy of the recording for the lift
   * effect. Without this prop, spotlight degrades to dim-only.
   */
  source_frame_url: string;
}

interface ActiveHighlight {
  ev: RecordedEvent;
  envelope_opacity: number;
  pulse: number;
  in_hold_phase: boolean;
}

function findActiveHighlight(
  events: RecordedEvent[],
  t_ms: number,
  zoom: ZoomProfile,
): ActiveHighlight | null {
  const tpl = zoom.templates.highlight;
  const inMs = tpl.duration_in_ms;
  const holdMs = tpl.hold_ms;
  const outMs = tpl.duration_out_ms;
  const ev = [...events]
    .reverse()
    .find(
      (e) =>
        e.kind === "highlight" &&
        typeof e.x === "number" &&
        typeof e.y === "number" &&
        typeof e.w === "number" &&
        typeof e.h === "number" &&
        t_ms >= e.t_ms - inMs &&
        t_ms <= e.t_ms + holdMs + outMs,
    );
  if (!ev) return null;
  const dt = t_ms - ev.t_ms;
  let envelope_opacity: number;
  if (dt < 0) {
    envelope_opacity = applyEase(tpl.ease_in, 1 + dt / inMs);
  } else if (dt < holdMs) {
    envelope_opacity = 1;
  } else {
    const out_t = (dt - holdMs) / outMs;
    envelope_opacity = 1 - applyEase(tpl.ease_out, Math.min(1, out_t));
  }
  // Subtle 1.5s sine-breath pulse during hold only.
  const PULSE_PERIOD_MS = 1500;
  const pulse =
    dt >= 0 && dt < holdMs
      ? 0.9 + 0.1 * Math.sin((dt / PULSE_PERIOD_MS) * Math.PI * 2)
      : 1;
  return { ev, envelope_opacity, pulse, in_hold_phase: dt >= 0 && dt < holdMs };
}

/**
 * `isHighlightActive` — exported so the cursor can hide itself when a
 * highlight is in flight. Avoids duplicating the envelope-window logic
 * across components.
 */
export function isHighlightActive(
  events: RecordedEvent[],
  t_ms: number,
  zoom: ZoomProfile,
): boolean {
  return findActiveHighlight(events, t_ms, zoom) !== null;
}

function bboxStyle(
  ev: RecordedEvent,
  viewport_width: number,
  viewport_height: number,
): React.CSSProperties {
  const left_pct = ((ev.x! - ev.w! / 2) / viewport_width) * 100;
  const top_pct = ((ev.y! - ev.h! / 2) / viewport_height) * 100;
  const w_pct = (ev.w! / viewport_width) * 100;
  const h_pct = (ev.h! / viewport_height) * 100;
  return {
    position: "absolute",
    left: `${left_pct}%`,
    top: `${top_pct}%`,
    width: `${w_pct}%`,
    height: `${h_pct}%`,
  };
}

export const HighlightTreatment: React.FC<HighlightTreatmentProps> = ({
  events,
  t_ms,
  viewport_width,
  viewport_height,
  zoom,
  brand,
  config,
  source_frame_url,
}) => {
  if (config.style === "off") return null;
  const active = findActiveHighlight(events, t_ms, zoom);
  if (!active) return null;

  if (config.style === "spotlight") {
    // Spotlight does NOT apply the sine pulse. The lift+dim+drop-shadow
    // is already a strong attention cue; multiplying through the pulse
    // (range 0.8–1.0) caused a visible 20% opacity dip mid-hold that
    // read as a flicker. The envelope alone (in/hold/out) is enough.
    // Border_glow keeps the pulse — there the pulse IS the attention
    // mechanism, not redundant.
    const opacity = active.envelope_opacity;
    // Spotlight: dim outside + LIFT inside. The lift is a scaled copy
    // of the source frame clipped to the bbox region. Layer order:
    //
    //   1. (parent) original source <Img> at base scale
    //   2. dim layer — box-shadow trick fills everything outside bbox
    //   3. lifted bbox copy — second <img>, clip-pathed to bbox region,
    //      scale(lift_scale) from bbox center
    //   4. lift outline + drop shadow on the bbox at the lifted scale
    //
    // The lifted copy uses the SAME source_frame_url as layer 1 — it's
    // just rendered again, clipped, and scaled. Browser caches the
    // image so this is essentially free.
    const dimRgba = `rgba(0, 0, 0, ${config.dim_opacity * opacity})`;
    const outlineRgba = `rgba(255, 255, 255, ${0.35 * opacity})`;
    const dropRgba = `rgba(0, 0, 0, ${0.55 * opacity})`;

    const ev = active.ev;
    const cx_pct = (ev.x! / viewport_width) * 100;
    const cy_pct = (ev.y! / viewport_height) * 100;

    // Clip-path inset values — the FOUR sides of the inset, each as a
    // percentage of the element's box. Clip-path is computed BEFORE
    // transform per CSS spec, so clipping happens in the element's
    // pre-transform box (which is full Stage size), then the clipped
    // region scales `lift_scale` from bbox center.
    const top_inset = ((ev.y! - ev.h! / 2) / viewport_height) * 100;
    const right_inset =
      ((viewport_width - (ev.x! + ev.w! / 2)) / viewport_width) * 100;
    const bottom_inset =
      ((viewport_height - (ev.y! + ev.h! / 2)) / viewport_height) * 100;
    const left_inset = ((ev.x! - ev.w! / 2) / viewport_width) * 100;

    const liftScale = config.lift_scale;
    // Animate scale THROUGH the envelope so the card lifts smoothly forward
    // (1.0 → liftScale during in-phase, hold at liftScale, recede during
    // out-phase). Without this the scale jumps to liftScale instantly while
    // only opacity rides the envelope, which reads as a glitch rather than
    // physical motion. envelope_opacity is already eased by ease_in /
    // ease_out from the highlight zoom template.
    const animatedScale = 1 + (liftScale - 1) * active.envelope_opacity;
    const bbox = bboxStyle(active.ev, viewport_width, viewport_height);

    return (
      <>
        {/* Dim layer — single huge box-shadow fills the rest of the Stage */}
        <div
          data-flourish="highlight-spotlight-dim"
          style={{
            ...bbox,
            borderRadius: config.corner_radius_px,
            boxShadow: `0 0 0 9999px ${dimRgba}`,
            pointerEvents: "none",
            willChange: "opacity, box-shadow",
          }}
        />
        {/* Lifted copy: a second source-frame img clip-pathed to the
            bbox + scaled `lift_scale` from bbox center. The visible
            (clipped) bbox region grows 1.5× outward, lifted forward
            off the page. */}
        {liftScale > 1 && source_frame_url && (
          <div
            data-flourish="highlight-spotlight-lift-frame"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
              clipPath: `inset(${top_inset}% ${right_inset}% ${bottom_inset}% ${left_inset}% round ${config.corner_radius_px}px)`,
              transform: `scale(${animatedScale})`,
              transformOrigin: `${cx_pct}% ${cy_pct}%`,
              pointerEvents: "none",
              willChange: "transform, opacity",
              opacity,
            }}
          >
            {/* Remotion <Img> integrates with delayRender so the frame
                doesn't compose until this second copy of the source frame
                is loaded. Raw <img> was causing the lifted card to flicker
                in/out for one frame at the start of the highlight envelope
                because Remotion would render before the img loaded. */}
            <Img
              src={source_frame_url}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: "fill",
                display: "block",
              }}
            />
          </div>
        )}
        {/* Lift: outline + drop shadow on the bbox at LIFTED scale.
            Same scale + transform-origin as the frame copy so the
            outline tracks the lifted region. */}
        {config.lift_outline && (
          <div
            data-flourish="highlight-spotlight-lift-outline"
            style={{
              ...bbox,
              borderRadius: config.corner_radius_px,
              boxShadow: `0 0 0 1px ${outlineRgba}, 0 18px 48px ${dropRgba}`,
              transform: `scale(${animatedScale})`,
              transformOrigin: "center center",
              pointerEvents: "none",
              willChange: "transform, opacity",
            }}
          />
        )}
      </>
    );
  }

  if (config.style === "border_glow") {
    // Border_glow KEEPS the sine pulse — a pulsing border is the
    // attention mechanism for tutorial/instructional flows, and the
    // 0.8–1.0 modulation reads as a deliberate "look at me" breath
    // rather than a glitch (the border is the only visible element,
    // so its opacity oscillation is intentional design, not a leak
    // from another mechanism competing with it).
    const opacity = active.envelope_opacity * active.pulse;
    const minDim = Math.min(viewport_width, viewport_height);
    const borderPx = Math.max(2, Math.round(minDim * 0.003));
    const color = brand.accent.startsWith("#") ? brand.accent : "#FFC857";
    return (
      <div
        data-flourish="highlight-border-glow"
        style={{
          ...bboxStyle(active.ev, viewport_width, viewport_height),
          borderRadius: config.corner_radius_px,
          border: `${borderPx}px solid ${color}`,
          boxShadow: `0 0 24px ${color}, inset 0 0 12px ${color}40`,
          opacity,
          pointerEvents: "none",
          willChange: "opacity",
          boxSizing: "border-box",
        }}
      />
    );
  }

  return null;
};
