/**
 * Spring physics for cursor smoothing.
 *
 * principle 3 (mass_and_weight): mass=1 default = light, snappy
 * principle 7 (follow_through): natural spring overshoot reads as overlap
 *
 * Reference shape (semi-implicit Euler integration) drawn from Framer Motion
 * and remotion-bits/src/utils/motion. We implement here rather than depend
 * directly so we can run inside the compositor and the recorder pre-render
 * for cursor path resolution.
 */

export interface SpringState {
  position: number;
  velocity: number;
}

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  /** Position threshold under which we consider the spring settled. */
  rest_threshold?: number;
}

const DEFAULT_REST = 0.01;

/**
 * Advance a 1D spring state by dt seconds toward `target`.
 *
 * Overshoot guard (pattern from Recordly's videoPlayback/motionSmoothing):
 * when the target moves and existing velocity carries the spring past the
 * new target, snap the position to target. Without this, repeated
 * connected-pan transitions accumulate residual velocity that produces
 * visible wobble. This is most common in cursor smoothing where the
 * target updates ~125Hz while the spring runs at 60Hz.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  cfg: SpringConfig,
  dt: number,
): SpringState {
  const { stiffness, damping, mass } = cfg;
  const fSpring = -stiffness * (state.position - target);
  const fDamper = -damping * state.velocity;
  const acceleration = (fSpring + fDamper) / mass;
  const newVelocity = state.velocity + acceleration * dt;
  const newPosition = state.position + newVelocity * dt;

  // Detect direction reversal that would overshoot the target.
  const wasBelow = state.position < target;
  const isBelow = newPosition < target;
  if (wasBelow !== isBelow) {
    // Crossed the target during this step; clamp to prevent overshoot
    // when the spring is overdamped. For underdamped springs, allow the
    // natural overshoot (it's the desired bounce).
    const dampingRatio = damping / (2 * Math.sqrt(Math.max(stiffness, 1e-6) * mass));
    if (dampingRatio >= 1) {
      return { position: target, velocity: 0 };
    }
  }

  return { position: newPosition, velocity: newVelocity };
}

/**
 * Resolve a 2D spring trajectory: given a sequence of (time, target) keyframes,
 * return per-frame interpolated positions at `fps` resolution. The cursor uses
 * this to convert event-driven Playwright coordinates into smooth per-frame motion.
 */
export interface KeyPoint {
  /** ms from start */
  t_ms: number;
  x: number;
  y: number;
}

export interface ResolvedFrame {
  t_ms: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed_px_per_s: number;
}

export function resolveSpringTrajectory(
  keypoints: KeyPoint[],
  cfg: SpringConfig,
  fps: number,
  /** Extra frames after the last keypoint so the spring has time to settle.
   *  Default 90 frames @ 60fps = 1.5s. Without this, the cursor freezes at
   *  whatever position the spring happened to be at when the last sample
   *  arrived — typically *before* it has reached the final target. */
  tail_frames = 90,
): ResolvedFrame[] {
  if (keypoints.length === 0) return [];
  const sorted = [...keypoints].sort((a, b) => a.t_ms - b.t_ms);
  const lastT = sorted[sorted.length - 1]?.t_ms ?? 0;
  const dtSec = 1 / fps;
  const dtMs = (1000 * 1) / fps;
  const totalFrames = Math.ceil(lastT / dtMs) + 1 + tail_frames;

  const startX = sorted[0]?.x ?? 0;
  const startY = sorted[0]?.y ?? 0;

  let stateX: SpringState = { position: startX, velocity: 0 };
  let stateY: SpringState = { position: startY, velocity: 0 };

  let kpIdx = 0;
  const out: ResolvedFrame[] = [];

  for (let i = 0; i < totalFrames; i++) {
    const t_ms = i * dtMs;

    // Advance keypoint cursor: target is the most recent keypoint at or before t_ms.
    while (kpIdx + 1 < sorted.length && (sorted[kpIdx + 1]?.t_ms ?? 0) <= t_ms) {
      kpIdx++;
    }
    const target = sorted[kpIdx];
    if (!target) continue;

    stateX = stepSpring(stateX, target.x, cfg, dtSec);
    stateY = stepSpring(stateY, target.y, cfg, dtSec);

    const speed = Math.sqrt(stateX.velocity ** 2 + stateY.velocity ** 2);
    out.push({
      t_ms,
      x: stateX.position,
      y: stateY.position,
      vx: stateX.velocity,
      vy: stateY.velocity,
      speed_px_per_s: speed,
    });
  }

  return out;
}

export function isSettled(state: SpringState, target: number, cfg: SpringConfig): boolean {
  const rest = cfg.rest_threshold ?? DEFAULT_REST;
  return Math.abs(state.position - target) < rest && Math.abs(state.velocity) < rest;
}
