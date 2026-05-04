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
  // Build caption windows from interactive events that carry a `note` field
  // (set by the recorder from the plan step's `note`). Captions show
  // lead_ms BEFORE the event fires (principle 4: anticipation) and persist
  // until the next interactive event.
  const windows: CaptionWindow[] = [];
  const interactiveKinds = new Set(["click", "type", "scroll", "hover", "input"]);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (!interactiveKinds.has(e.kind)) continue;
    const text = (e.note ?? "").trim();
    if (!text) continue;
    // End of this caption: just before the next interactive event with a note,
    // or 2.5s after this event if it's the last.
    let window_end = e.t_ms + 2500;
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (!next) continue;
      if (interactiveKinds.has(next.kind) && (next.note ?? "").trim()) {
        window_end = next.t_ms - 50;
        break;
      }
    }
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
