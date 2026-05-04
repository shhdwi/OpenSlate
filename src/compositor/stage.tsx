/**
 * Stage — the recording-coordinate-space container.
 *
 * THE INVARIANT THIS ENFORCES:
 *
 *   "Anything that needs to position relative to the recording (cursor,
 *    click highlights, annotations, future overlays) must be a child of
 *    Stage and use PERCENTAGES of viewport dimensions for positioning,
 *    not canvas pixels."
 *
 * Why: the recording is captured at a viewport size (e.g., 1280×800) but
 * rendered at output canvas size (e.g., 1920×1080) inside a frame chrome
 * with padding. The recording's pixel position on canvas is NOT (1280, 800).
 * Click events come back from Playwright in viewport coords. To make a
 * cursor or click halo land on the right pixel of the rendered recording,
 * the position must be expressed as a fraction of viewport dimensions
 * INSIDE a container that has the recording's aspect ratio.
 *
 * Stage owns:
 *   - aspect-ratio: viewport_w / viewport_h
 *   - the auto-zoom transform (scale + translate)
 *   - overflow: hidden (clip transformed content to stage bounds)
 *   - centering inside the parent via flex (callers wrap Stage in a flex
 *     centerer; see composition.tsx)
 *
 * Children expressing positions:
 *   - left: ${(x / viewport_width) * 100}%
 *   - top:  ${(y / viewport_height) * 100}%
 *
 * If you find yourself writing pixel positions inside a Stage child, you
 * are creating the same drift bug we already fixed twice (cursor + click
 * highlight). Use the helper viewportToPctPos() below.
 */

import React from "react";

export interface StageProps {
  viewport_width: number;
  viewport_height: number;
  /** CSS transform string (scale, translate, etc.) applied to the stage. */
  transform?: string;
  /** Children render at recording-coordinate-space. */
  children: React.ReactNode;
}

export const Stage: React.FC<StageProps> = ({
  viewport_width,
  viewport_height,
  transform,
  children,
}) => {
  return (
    <div
      style={{
        // The aspect ratio is the LOAD-BEARING property — it's why
        // percentage-positioned children land on recording pixels. Don't
        // remove it; don't override it from outside.
        aspectRatio: `${viewport_width} / ${viewport_height}`,
        // Take all available height, width auto-determined by aspect.
        height: "100%",
        maxWidth: "100%",
        position: "relative",
        transform,
        transformOrigin: "0 0",
        willChange: "transform",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
};

/**
 * Convert a viewport-space pixel coordinate to a percentage string suitable
 * for CSS `left`/`top` inside a Stage child. Use this everywhere you'd
 * be tempted to write a pixel value.
 */
export function viewportToPct(
  px: number,
  viewport_dim: number,
): string {
  return `${(px / viewport_dim) * 100}%`;
}

/**
 * Same but returns x AND y as { left, top } strings for spreading into
 * a style object: `style={{ ...viewportToPctPos(x, y, vw, vh) }}`.
 */
export function viewportToPctPos(
  x: number,
  y: number,
  viewport_width: number,
  viewport_height: number,
): { left: string; top: string } {
  return {
    left: `${(x / viewport_width) * 100}%`,
    top: `${(y / viewport_height) * 100}%`,
  };
}
