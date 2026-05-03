/**
 * Flourishes are vector animations layered over the recording at specific
 * moments — outro logo reveal, click highlights, step badges, scene title
 * cards, success bursts.
 *
 * Each flourish is a self-contained Remotion subcomponent that receives:
 *   - the slice of the polish profile relevant to it
 *   - the brand kit
 *   - the current t_ms
 *   - the events log (so it can locate its trigger moment)
 */

import type React from "react";
import type { BrandKit, FlourishesProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";

export interface FlourishContext {
  brand: BrandKit;
  events: RecordedEvent[];
  /** ms from start of recording */
  t_ms: number;
  /** ms total duration of the polished output */
  total_duration_ms: number;
}

export type FlourishComponent<P> = React.FC<P & { ctx: FlourishContext }>;

export interface FlourishesAggregateProps {
  profile: FlourishesProfile;
  brand: BrandKit;
  events: RecordedEvent[];
  t_ms: number;
  total_duration_ms?: number;
}
