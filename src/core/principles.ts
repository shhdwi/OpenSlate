/**
 * The 10 motion-design principles. Every default in polish.config.ts traces
 * to one or more of these. If a parameter does not trace, it is a vibes
 * decision and should be challenged.
 *
 * Drawn from Disney's 12 classic principles, adapted for motion design as
 * laid out by Joshua's "10 motion design principles" framing.
 */

export const Principle = {
  TIMING_AND_SPACING: "timing_and_spacing",
  EASINGS: "easings",
  MASS_AND_WEIGHT: "mass_and_weight",
  ANTICIPATION: "anticipation",
  ARCS: "arcs",
  SQUASH_AND_STRETCH: "squash_and_stretch",
  FOLLOW_THROUGH: "follow_through",
  EXAGGERATION: "exaggeration",
  SECONDARY_ANIMATION: "secondary_animation",
  APPEAL: "appeal",
} as const;

export type Principle = (typeof Principle)[keyof typeof Principle];

export const PRINCIPLE_META: Record<
  Principle,
  { number: number; name: string; one_liner: string; v1_status: "honored" | "partial" | "test_only" }
> = {
  timing_and_spacing: {
    number: 1,
    name: "Timing & spacing",
    one_liner: "60fps locked; per-frame motion shaped by easing.",
    v1_status: "honored",
  },
  easings: {
    number: 2,
    name: "Easings",
    one_liner: "Never linear; named eases on every animated property.",
    v1_status: "honored",
  },
  mass_and_weight: {
    number: 3,
    name: "Mass & weight",
    one_liner: "Cursor light/snappy; frame grounded; bg subordinate.",
    v1_status: "honored",
  },
  anticipation: {
    number: 4,
    name: "Anticipation",
    one_liner: "Cursor settles before clicking; captions lead the action.",
    v1_status: "honored",
  },
  arcs: {
    number: 5,
    name: "Arcs",
    one_liner: "Curved paths over straight lines.",
    v1_status: "partial", // v1: spring overshoot only; v1.5: full bezier paths
  },
  squash_and_stretch: {
    number: 6,
    name: "Squash & stretch",
    one_liner: "Restrained click bounce; not everything squashes.",
    v1_status: "honored",
  },
  follow_through: {
    number: 7,
    name: "Follow-through & overlap",
    one_liner: "Motion blur, post-zoom cursor recover, last-word lag.",
    v1_status: "honored",
  },
  exaggeration: {
    number: 8,
    name: "Exaggeration",
    one_liner: "Gestures amplified; restraint axiom: one per beat.",
    v1_status: "honored",
  },
  secondary_animation: {
    number: 9,
    name: "Secondary animation",
    one_liner: "Background parallax during zoom; shadow follows frame.",
    v1_status: "honored",
  },
  appeal: {
    number: 10,
    name: "Appeal",
    one_liner: "Emergent; tested via the friend test, not configured.",
    v1_status: "test_only",
  },
};

/**
 * Named easing curves. We never use linear except as a control / reference.
 * Curve definitions are bezier control points (p1x, p1y, p2x, p2y) in 0..1.
 * Reference: cubic-bezier from CSS / Framer Motion / Remotion easing tables.
 */
export const Ease = {
  linear: "linear",
  quad_in: "quad_in",
  quad_out: "quad_out",
  quad_in_out: "quad_in_out",
  cubic_in: "cubic_in",
  cubic_out: "cubic_out",
  cubic_in_out: "cubic_in_out",
  quart_in: "quart_in",
  quart_out: "quart_out",
  quart_in_out: "quart_in_out",
  quint_in: "quint_in",
  quint_out: "quint_out",
  expo_in: "expo_in",
  expo_out: "expo_out",
  back_in: "back_in",
  back_out: "back_out",
  back_in_out: "back_in_out",
  sine_in: "sine_in",
  sine_out: "sine_out",
  sine_in_out: "sine_in_out",
} as const;

export type EaseName = (typeof Ease)[keyof typeof Ease];
