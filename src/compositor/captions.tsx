/**
 * Captions overlay. v1 supports `from_steps` mode — each plan step's `note`
 * field becomes a caption shown for the duration of that step.
 *
 * principle 1 (timing_and_spacing): stagger_words_ms = 5 frames @ 60fps
 * principle 2 (easings): word reveal uses cubic_out
 * principle 4 (anticipation): captions appear lead_ms BEFORE the action
 */

import React from "react";
import type { CaptionsProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";

export interface CaptionsProps {
  profile: CaptionsProfile;
  events: RecordedEvent[];
  t_ms: number;
}

interface CaptionWindow {
  start_ms: number;
  end_ms: number;
  text: string;
}

export const Captions: React.FC<CaptionsProps> = ({ profile, events, t_ms }) => {
  // Build caption windows from clicks/inputs — v1 sources from event notes
  // (which the plan step `note` field provides via the recorder).
  const windows: CaptionWindow[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (e.kind !== "click" && e.kind !== "input" && e.kind !== "scroll") continue;
    // Heuristic v1 caption text — recorder doesn't yet inject step notes into
    // events; this is a stub. v1.5 will plumb step.note into the event log.
    const text = "";
    if (!text) continue;
    const next = events[i + 1];
    const window_end = next ? next.t_ms : e.t_ms + 2500;
    windows.push({
      start_ms: Math.max(0, e.t_ms - profile.lead_ms),
      end_ms: window_end,
      text,
    });
  }

  const active = windows.find((w) => t_ms >= w.start_ms && t_ms <= w.end_ms);
  if (!active) return null;

  return (
    <CaptionRender
      text={active.text}
      profile={profile}
      local_t_ms={t_ms - active.start_ms}
    />
  );
};

const CaptionRender: React.FC<{
  text: string;
  profile: CaptionsProfile;
  local_t_ms: number;
}> = ({ text, profile, local_t_ms }) => {
  const words = text.split(/\s+/);

  const positionStyle = positionToCss(profile.position);

  return (
    <div
      style={{
        position: "absolute",
        ...positionStyle,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          padding: "10px 18px",
          borderRadius: 10,
          background: hexA(profile.style.bg_color, profile.style.bg_opacity),
          color: profile.style.text_color,
          fontWeight: profile.style.font_weight,
          fontSize: 22,
          letterSpacing: 0.2,
          maxWidth: "70%",
          textAlign: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.3em",
          justifyContent: "center",
        }}
      >
        {words.map((word, idx) => {
          const reveal_t = (local_t_ms - idx * profile.style.stagger_words_ms) / 250;
          const t = Math.max(0, Math.min(1, reveal_t));
          const eased = applyEase(profile.style.ease, t);
          return (
            <span
              key={`${word}-${idx}`}
              style={{
                display: "inline-block",
                opacity: eased,
                transform: `translateY(${(1 - eased) * 6}px)`,
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    </div>
  );
};

function positionToCss(position: CaptionsProfile["position"]): React.CSSProperties {
  switch (position) {
    case "lower_third":
      return { left: 0, right: 0, bottom: "12%" };
    case "upper_third":
      return { left: 0, right: 0, top: "12%" };
    case "centered":
      return { left: 0, right: 0, top: "50%", transform: "translateY(-50%)" };
  }
}

function hexA(hex: string, a: number): string {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return `rgba(0,0,0,${a})`;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
