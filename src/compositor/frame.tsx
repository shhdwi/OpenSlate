/**
 * Device frame chrome. Wraps the recording in a laptop / phone / browser /
 * macOS window mock. v1 uses CSS-rendered frames (lightweight, no asset
 * pipeline). v2 will allow asset-based frames (PNG/SVG overlays) for
 * higher fidelity.
 *
 * principle 3 (mass_and_weight): radius + inset shadow + outer drop shadow
 * principle 9 (secondary_animation): outer shadow follows zoom (when enabled
 * upstream — composition tracks easedScale and will pass shadow modulation).
 */

import React from "react";
import type { BrandKit, FrameProfile, LayoutProfile } from "../core/types.js";

export interface FrameProps {
  profile: FrameProfile;
  layout: LayoutProfile;
  brand: BrandKit;
  children: React.ReactNode;
}

export const Frame: React.FC<FrameProps> = ({ profile, layout, brand, children }) => {
  if (profile.style === "none") {
    return (
      <div
        style={{
          position: "absolute",
          inset: layout.padding_px,
          borderRadius: profile.radius_px,
          overflow: "hidden",
          boxShadow: shadowCss(layout, brand),
        }}
      >
        {children}
      </div>
    );
  }

  const isPhone = profile.style === "phone_minimal";
  const isLaptop = profile.style === "laptop_minimal";
  const isBrowser =
    profile.style === "browser_safari" || profile.style === "browser_chrome";
  const isWindow = profile.style === "window_macos";

  const isDarkTheme = profile.theme === "dark";
  const chromeBg = isDarkTheme ? "#1A1A1F" : "#FFFFFF";
  const chromeBorder = isDarkTheme ? "#2C2C33" : "#E5E5EA";
  const chromeText = isDarkTheme ? "#F7F7FA" : "#1A1A1F";

  const trafficLights =
    profile.chrome.traffic_lights && (isBrowser || isWindow) ? (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Dot color="#FF5F57" />
        <Dot color="#FEBC2E" />
        <Dot color="#28C840" />
      </div>
    ) : null;

  if (isPhone) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: "min(28%, 420px)",
            aspectRatio: "9 / 19.5",
            borderRadius: 56,
            background: chromeBg,
            border: `1.5px solid ${chromeBorder}`,
            boxShadow: shadowCss(layout, brand),
            padding: 10,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* dynamic-island-ish notch */}
          <div
            style={{
              position: "absolute",
              top: 18,
              left: "50%",
              transform: "translateX(-50%)",
              width: 92,
              height: 28,
              borderRadius: 14,
              background: "#000",
              zIndex: 2,
            }}
          />
          <div
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              borderRadius: 44,
              overflow: "hidden",
              background: "#000",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    );
  }

  if (isLaptop) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: layout.padding_px,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "calc(100% - 8%)",
            aspectRatio: "16 / 10",
            position: "relative",
          }}
        >
          {/* lid */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 18,
              background: chromeBg,
              border: `1.5px solid ${chromeBorder}`,
              boxShadow: shadowCss(layout, brand),
              padding: 14,
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: 8,
                overflow: "hidden",
                position: "relative",
                background: "#000",
              }}
            >
              {children}
            </div>
          </div>
          {/* hinge */}
          <div
            style={{
              position: "absolute",
              left: "-3%",
              right: "-3%",
              bottom: -10,
              height: 12,
              background: chromeBorder,
              borderRadius: 4,
            }}
          />
        </div>
      </div>
    );
  }

  if (isBrowser || isWindow) {
    const showUrlBar = isBrowser && profile.chrome.url_bar;
    const titleText = profile.chrome.title;
    return (
      <div
        style={{
          position: "absolute",
          inset: layout.padding_px,
          borderRadius: profile.radius_px + 4,
          background: chromeBg,
          border: `1px solid ${chromeBorder}`,
          boxShadow: shadowCss(layout, brand),
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            height: 36,
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            borderBottom: `1px solid ${chromeBorder}`,
            background: chromeBg,
            color: chromeText,
            gap: 12,
          }}
        >
          {trafficLights}
          {titleText && <div style={{ fontSize: 13, fontWeight: 500 }}>{titleText}</div>}
          {showUrlBar && (
            <div
              style={{
                flex: 1,
                background: isDarkTheme ? "#2C2C33" : "#F0F0F4",
                height: 22,
                borderRadius: 6,
                marginLeft: 8,
              }}
            />
          )}
        </div>
        <div style={{ position: "relative", flex: 1 }}>{children}</div>
      </div>
    );
  }

  return null;
};

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ width: 12, height: 12, borderRadius: 6, background: color }} />
);

function shadowCss(layout: LayoutProfile, brand: BrandKit): string {
  const color =
    layout.shadow.color === "auto" ? "rgba(10,10,15,0.5)" : hexToRgba(layout.shadow.color, layout.shadow.opacity);
  return `0 ${layout.shadow.offset_y_px}px ${layout.shadow.px}px ${color}`;
  void brand;
}

function hexToRgba(hex: string, opacity: number): string {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return `rgba(0,0,0,${opacity})`;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}
