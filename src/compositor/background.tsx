/**
 * Background renderer. Solids, gradients, wallpapers, custom images.
 *
 * principle 9 (secondary_animation): parallax_x/y from composition (zoom-driven)
 * principle 10 (appeal): grain overlay prevents pure-CGI sterility
 */

import React from "react";
import { AbsoluteFill } from "remotion";
import type { BackgroundProfile, BrandKit } from "../core/types.js";

export interface BackgroundProps {
  profile: BackgroundProfile;
  brand: BrandKit;
  parallax_x: number;
  parallax_y: number;
}

export const Background: React.FC<BackgroundProps> = ({ profile, brand, parallax_x, parallax_y }) => {
  const baseStyle: React.CSSProperties = {
    transform: `translate(${parallax_x}px, ${parallax_y}px) scale(1.02)`,
    transformOrigin: "center center",
    willChange: "transform",
  };

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ ...baseStyle, ...resolveBackground(profile, brand) }} />
      {profile.grain_overlay > 0 && <Grain opacity={profile.grain_overlay} />}
    </AbsoluteFill>
  );
};

function resolveBackground(profile: BackgroundProfile, brand: BrandKit): React.CSSProperties {
  switch (profile.style) {
    case "solid_white":
      return { background: "#FFFFFF" };
    case "solid_black":
      return { background: "#0A0A0F" };
    case "gradient_brand":
      return {
        background: `linear-gradient(135deg, ${brand.primary} 0%, ${darken(brand.primary, 0.25)} 50%, ${brand.neutral_dark} 100%)`,
      };
    case "gradient_sunset":
      return {
        background: "linear-gradient(135deg, #FF6B6B 0%, #FFB86C 50%, #FFE066 100%)",
      };
    case "gradient_ocean":
      return {
        background: "linear-gradient(135deg, #2BB5E0 0%, #1E5C9A 50%, #0F2D52 100%)",
      };
    case "gradient_violet":
      return {
        background: "linear-gradient(135deg, #B589F6 0%, #6E4BC6 50%, #2B1655 100%)",
      };
    case "gradient_slate":
      return {
        background: "linear-gradient(135deg, #4A5566 0%, #2C3340 50%, #15171C 100%)",
      };
    case "wallpaper_minimal_1":
    case "wallpaper_minimal_2":
    case "wallpaper_minimal_3":
      // v1 stub: ship the gradients and treat wallpapers as gradient_slate until
      // designer assets land. Marked TODO.
      return {
        background: "linear-gradient(135deg, #2A2D33 0%, #1A1C20 100%)",
      };
    case "image_custom":
      if (profile.custom_image_path) {
        return {
          backgroundImage: `url("${profile.custom_image_path}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: profile.blur_px > 0 ? `blur(${profile.blur_px}px)` : undefined,
        };
      }
      return { background: "#1A1C20" };
  }
}

const Grain: React.FC<{ opacity: number }> = ({ opacity }) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      opacity,
      mixBlendMode: "overlay",
      // Cheap, tile-able SVG noise. v1.5 should swap to a baked PNG for
      // determinism across renders.
      backgroundImage:
        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.95' numOctaves='2' stitchTiles='stitch'/></filter><rect width='256' height='256' filter='url(%23n)' opacity='0.4'/></svg>\")",
      backgroundSize: "256px 256px",
    }}
  />
);

function darken(hex: string, amount: number): string {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return hex;
  const v = m[1];
  const r = Math.max(0, parseInt(v.slice(0, 2), 16) - 255 * amount);
  const g = Math.max(0, parseInt(v.slice(2, 4), 16) - 255 * amount);
  const b = Math.max(0, parseInt(v.slice(4, 6), 16) - 255 * amount);
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
